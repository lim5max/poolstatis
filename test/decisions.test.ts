import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { activeMetric, api, createTestEnv, type TestEnv } from './helpers.js';
import { proposeOutcome } from '../src/services/evaluation.js';

const DAY = 86_400_000;

describe('release evidence and immutable decision revisions', () => {
  let env: TestEnv;
  let other: TestEnv;
  let anchor: Date;

  beforeAll(async () => {
    env = await createTestEnv();
    other = await createTestEnv();
    anchor = new Date(Date.now() - 4 * DAY);
    await activeMetric(env, {
      key: 'activation_completed', type: 'unique_actors',
      purpose: 'Measures whether signed-up actors reach the first product value moment.',
      source: { event: 'activation.completed', filters: [] },
    });
    await activeMetric(env, {
      key: 'invite_completed', type: 'unique_actors',
      purpose: 'Protects the invite outcome while an onboarding change is observed.',
      source: { event: 'invite.completed', filters: [] },
    });
    await api(env, env.secretToken, 'POST', path(env, '/properties'), {
      key: 'plan', scope: 'event', value_type: 'string', status: 'trusted',
      purpose: 'Segments decision evidence by the commercial plan selected by an actor.',
    });
    const declaration = {
      version: 1,
      contracts: [
        contract('shorter_onboarding', 5),
        contract('high_sample_onboarding', 1_000),
        { ...contract('activation_should_decrease', 5), expected_direction: 'decrease' },
      ],
    };
    const diff = await api(env, env.secretToken, 'POST', path(env, '/contracts/diff'), declaration);
    const applied = await api(env, env.secretToken, 'POST', path(env, '/contracts/apply'), {
      declaration, expected_revision: diff.body.expected_revision,
    });
    expect(applied.status).toBe(200);
    await ingestWindowEvidence(env, anchor, env.ingestToken, 'decision-evidence-prod');
    await ingestWindowEvidence(env, anchor, env.ingestDevToken, 'decision-evidence-dev');
  });

  afterAll(async () => {
    await env.close();
    await other.close();
  });

  test('separates measured facts from interpretation and approves a reproducible proposal', async () => {
    const release = await register(env, 'decision-approve', 'shorter_onboarding', anchor);
    const evaluated = await api(env, env.secretToken, 'POST', path(env, `/releases/${release.id}/evaluate`), {});
    expect(evaluated.status).toBe(201);
    expect(evaluated.body.idempotent).toBe(false);
    expect(evaluated.body.evidence).toMatchObject({
      release_id: release.id,
      source: 'native',
      ready: true,
      sample_size: 15,
      primary_evidence: {
        metric: { key: 'activation_completed', purpose: 'Measures whether signed-up actors reach the first product value moment.' },
        baseline: { value: 10, actors: 10 },
        observed: { value: 15, actors: 15 },
        change: { absolute: 5, relative: 0.5 },
      },
      trust: expect.objectContaining({ status: 'trusted', distinct_id_coverage: 1 }),
      blockers: [],
    });
    expect(evaluated.body.evidence.guardrail_evidence).toHaveLength(1);
    expect(evaluated.body.evidence.guardrail_evidence[0]).toMatchObject({
      metric: { key: 'invite_completed' },
      baseline: { value: 10 }, observed: { value: 10 },
    });
    expect(evaluated.body.evidence.facts).toMatchObject({
      expected_direction: 'increase', minimum_meaningful_effect: 0.1,
      observation_complete: true, sample_requirement_met: true,
    });
    expect(evaluated.body.evidence.query_specs.primary.observed.query).toMatchObject({
      kind: 'trend', metric: 'activation_completed', env: 'prod',
      filters: [{ property: 'plan', op: 'eq', value: 'pro' }],
    });
    expect(evaluated.body.decision).toMatchObject({
      status: 'proposed', proposed_outcome: 'keep', current_revision: 1,
    });
    expect(evaluated.body.decision.proposed_rationale).toContain('50%');

    const approved = await api(env, env.secretToken, 'POST', path(env, `/decisions/${evaluated.body.decision.id}/approve`), {
      rationale: 'The measured activation lift clears the declared threshold and the guardrail is stable.',
    });
    expect(approved.status).toBe(200);
    expect(approved.body.decision).toMatchObject({
      status: 'approved', accepted_outcome: 'keep', current_revision: 2,
    });
    expect(approved.body.revisions.map((revision: { action: string }) => revision.action))
      .toEqual(['proposed', 'approved']);
    expect(approved.body.release.status).toBe('decided');

    const detail = await api(env, env.secretToken, 'GET', path(env, `/decisions/${evaluated.body.decision.id}`));
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({
      decision: { accepted_outcome: 'keep' },
      evidence: { id: evaluated.body.evidence.id },
      release: { id: release.id, contract_revision: 1 },
      contract: { key: 'shorter_onboarding' },
    });
    const listed = await api(env, env.secretToken, 'GET', path(env, '/decisions?status=approved'));
    expect(listed.body.decisions).toEqual([
      expect.objectContaining({ id: evaluated.body.decision.id, accepted_outcome: 'keep' }),
    ]);
    const crossProject = await api(env, env.secretToken, 'GET', path(other, `/decisions/${evaluated.body.decision.id}`));
    expect(crossProject.status).toBe(404);

    await expect(env.pool.query('UPDATE evidence_sets SET ready = false WHERE id = $1', [evaluated.body.evidence.id]))
      .rejects.toMatchObject({ code: '55000' });
    await expect(env.pool.query(
      'UPDATE decision_revisions SET rationale = $2 WHERE decision_id = $1',
      [evaluated.body.decision.id, 'tampered'],
    )).rejects.toMatchObject({ code: '55000' });
  });

  test('preserves a rejected agent proposal and appends the human correction', async () => {
    const release = await register(env, 'decision-correct', 'shorter_onboarding', anchor);
    const evaluated = await api(env, env.secretToken, 'POST', path(env, `/releases/${release.id}/evaluate`), {});
    expect(evaluated.body.decision.proposed_outcome).toBe('keep');

    const rejected = await api(env, env.secretToken, 'POST', path(env, `/decisions/${evaluated.body.decision.id}/reject`), {
      rationale: 'The agent did not account for a known campaign change in this observation window.',
    });
    expect(rejected.body.decision).toMatchObject({ status: 'rejected', accepted_outcome: null });
    expect(rejected.body.revisions[1]).toMatchObject({
      action: 'rejected',
      previous_snapshot: expect.objectContaining({ status: 'proposed', proposed_outcome: 'keep' }),
    });

    const edited = await api(env, env.secretToken, 'POST', path(env, `/decisions/${evaluated.body.decision.id}/edit`), {
      outcome: 'keep',
      rationale: 'Keep the change, but record that the campaign is a confounder and recheck the next clean cohort.',
    });
    expect(edited.body.decision).toMatchObject({
      status: 'approved', accepted_outcome: 'keep', current_revision: 3,
    });
    expect(edited.body.revisions.map((revision: { action: string }) => revision.action))
      .toEqual(['proposed', 'rejected', 'edited']);
    expect(edited.body.revisions[0].snapshot.proposed_rationale).toBe(evaluated.body.decision.proposed_rationale);
  });

  test('filters the decision list by joined release environment while preserving the unfiltered contract', async () => {
    const prodRelease = await register(env, 'decision-env-prod', 'shorter_onboarding', anchor, 'prod');
    const devRelease = await register(env, 'decision-env-dev', 'shorter_onboarding', anchor, 'dev');
    const prodDecision = await api(env, env.secretToken, 'POST', path(env, `/releases/${prodRelease.id}/evaluate`), {});
    const devDecision = await api(env, env.secretToken, 'POST', path(env, `/releases/${devRelease.id}/evaluate`), {});
    expect(prodDecision.status).toBe(201);
    expect(devDecision.status).toBe(201);

    const unfiltered = await api(env, env.secretToken, 'GET', path(env, '/decisions'));
    const unfilteredIds = unfiltered.body.decisions.map((item: { id: string }) => item.id);
    expect(unfilteredIds).toEqual(expect.arrayContaining([prodDecision.body.decision.id, devDecision.body.decision.id]));

    const prodOnly = await api(env, env.secretToken, 'GET', path(env, '/decisions?env=prod'));
    const prodIds = prodOnly.body.decisions.map((item: { id: string }) => item.id);
    expect(prodIds).toContain(prodDecision.body.decision.id);
    expect(prodIds).not.toContain(devDecision.body.decision.id);

    const devOnly = await api(env, env.secretToken, 'GET', path(env, '/decisions?env=dev&status=proposed'));
    const devIds = devOnly.body.decisions.map((item: { id: string }) => item.id);
    expect(devIds).toContain(devDecision.body.decision.id);
    expect(devIds).not.toContain(prodDecision.body.decision.id);

    const mismatchedRelease = await api(
      env,
      env.secretToken,
      'GET',
      path(env, `/decisions?env=prod&release_id=${devRelease.id}`),
    );
    expect(mismatchedRelease.body.decisions).toEqual([]);

    const crossProject = await api(env, env.secretToken, 'GET', path(other, '/decisions?env=dev'));
    expect(crossProject.status).toBe(404);
  });

  test('filters a Decisions handoff by the release experiment identity', async () => {
    const taggedRelease = await register(env, 'decision-experiment-tagged', 'shorter_onboarding', anchor, 'prod', 'shorter_signup');
    const otherRelease = await register(env, 'decision-experiment-other', 'shorter_onboarding', anchor, 'prod', 'other_signup');
    const taggedDecision = await api(env, env.secretToken, 'POST', path(env, `/releases/${taggedRelease.id}/evaluate`), {});
    const otherDecision = await api(env, env.secretToken, 'POST', path(env, `/releases/${otherRelease.id}/evaluate`), {});

    const filtered = await api(env, env.secretToken, 'GET', path(env, '/decisions?env=prod&experiment_key=shorter_signup'));
    expect(filtered.status).toBe(200);
    expect(filtered.body.decisions.map((item: { id: string }) => item.id)).toContain(taggedDecision.body.decision.id);
    expect(filtered.body.decisions.map((item: { id: string }) => item.id)).not.toContain(otherDecision.body.decision.id);
  });

  test('owns queue ranking by evidence readiness, risk and age on the server', async () => {
    const oldRiskRelease = await register(env, 'decision-rank-old-risk', 'activation_should_decrease', anchor);
    const newRiskRelease = await register(env, 'decision-rank-new-risk', 'activation_should_decrease', anchor);
    const readyLowRiskRelease = await register(env, 'decision-rank-ready-low', 'shorter_onboarding', anchor);
    const blockedRelease = await register(env, 'decision-rank-blocked', 'high_sample_onboarding', anchor);
    const oldRisk = await api(env, env.secretToken, 'POST', path(env, `/releases/${oldRiskRelease.id}/evaluate`), {});
    const newRisk = await api(env, env.secretToken, 'POST', path(env, `/releases/${newRiskRelease.id}/evaluate`), {});
    const readyLowRisk = await api(env, env.secretToken, 'POST', path(env, `/releases/${readyLowRiskRelease.id}/evaluate`), {});
    const blocked = await api(env, env.secretToken, 'POST', path(env, `/releases/${blockedRelease.id}/evaluate`), {});
    expect(oldRisk.body.decision.proposed_outcome).toBe('rollback');
    expect(newRisk.body.decision.proposed_outcome).toBe('rollback');
    expect(readyLowRisk.body.decision.proposed_outcome).toBe('keep');
    expect(blocked.body.decision.proposed_outcome).toBe('inconclusive');

    await env.pool.query(
      `UPDATE decisions SET created_at = fixture.created_at::timestamptz
       FROM (VALUES ($1::uuid, '2026-08-01T00:00:00Z'), ($2::uuid, '2026-08-02T00:00:00Z'),
                    ($3::uuid, '2026-07-01T00:00:00Z'), ($4::uuid, '2026-06-01T00:00:00Z'))
         AS fixture(id, created_at)
       WHERE decisions.id = fixture.id`,
      [oldRisk.body.decision.id, newRisk.body.decision.id, readyLowRisk.body.decision.id, blocked.body.decision.id],
    );

    const listed = await api(env, env.secretToken, 'GET', path(env, '/decisions?env=prod'));
    expect(listed.status).toBe(200);
    const queueIds = listed.body.decisions.map((item: { id: string }) => item.id);
    const positions = [
      oldRisk.body.decision.id,
      newRisk.body.decision.id,
      readyLowRisk.body.decision.id,
      blocked.body.decision.id,
    ].map((id) => queueIds.indexOf(id));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(listed.body.decisions.find((item: { id: string }) => item.id === oldRisk.body.decision.id)).toMatchObject({
      queue_priority: { evidence_readiness: 'ready', risk: 'high' },
    });
    expect(listed.body.decisions.find((item: { id: string }) => item.id === blocked.body.decision.id)).toMatchObject({
      queue_priority: { evidence_readiness: 'blocked', risk: 'medium' },
    });
  });

  test('never turns insufficient sample or current property distrust into a directional decision', async () => {
    const lowSample = await register(env, 'decision-low-sample', 'high_sample_onboarding', anchor);
    const insufficient = await api(env, env.secretToken, 'POST', path(env, `/releases/${lowSample.id}/evaluate`), {});
    expect(insufficient.status).toBe(201);
    expect(insufficient.body.evidence.ready).toBe(false);
    expect(insufficient.body.evidence.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'minimum_sample_not_reached' }),
    ]));
    expect(insufficient.body.decision.proposed_outcome).toBe('inconclusive');

    const distrustRelease = await register(env, 'decision-untrusted-property', 'shorter_onboarding', anchor);
    await api(env, env.secretToken, 'PATCH', path(env, '/properties/event/plan'), { status: 'untrusted' });
    const distrusted = await api(env, env.secretToken, 'POST', path(env, `/releases/${distrustRelease.id}/evaluate`), {});
    expect(distrusted.status).toBe(201);
    expect(distrusted.body.evidence.trust.status).toBe('untrusted');
    expect(distrusted.body.evidence.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'untrusted_target_property' }),
    ]));
    expect(distrusted.body.decision.proposed_outcome).toBe('inconclusive');

    const forbiddenEdit = await api(env, env.secretToken, 'POST', path(env, `/decisions/${distrusted.body.decision.id}/edit`), {
      outcome: 'rollback',
      rationale: 'Force a directional conclusion despite the property trust blocker.',
    });
    expect(forbiddenEdit.status).toBe(409);
    expect(forbiddenEdit.body.error.code).toBe('directional_decision_forbidden');
    await api(env, env.secretToken, 'PATCH', path(env, '/properties/event/plan'), { status: 'trusted' });
  });
});

describe('decision policy directions', () => {
  test('handles increase, decrease, stay-within-range and guardrail override explicitly', () => {
    expect(proposeOutcome({
      ready: true, expectedDirection: 'increase', minimumEffect: 0.1,
      primaryRelative: 0.2, guardrailRegression: false,
    })).toBe('keep');
    expect(proposeOutcome({
      ready: true, expectedDirection: 'increase', minimumEffect: 0.1,
      primaryRelative: -0.2, guardrailRegression: false,
    })).toBe('rollback');
    expect(proposeOutcome({
      ready: true, expectedDirection: 'decrease', minimumEffect: 0.1,
      primaryRelative: -0.2, guardrailRegression: false,
    })).toBe('keep');
    expect(proposeOutcome({
      ready: true, expectedDirection: 'stay_within_range', minimumEffect: 0.1,
      primaryRelative: 0.05, guardrailRegression: false,
    })).toBe('keep');
    expect(proposeOutcome({
      ready: true, expectedDirection: 'stay_within_range', minimumEffect: 0.1,
      primaryRelative: 0.2, guardrailRegression: false,
    })).toBe('fix');
    expect(proposeOutcome({
      ready: true, expectedDirection: 'increase', minimumEffect: 0.1,
      primaryRelative: 0.3, guardrailRegression: true,
    })).toBe('fix');
    expect(proposeOutcome({
      ready: false, expectedDirection: 'increase', minimumEffect: 0.1,
      primaryRelative: 0.3, guardrailRegression: false,
    })).toBe('inconclusive');
  });
});

describe('PostHog-backed release evaluation', () => {
  let env: TestEnv;
  let host: string;
  const upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = chunks.length
      ? JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      : null;
    routeEvaluationPostHog(req, res, body);
  });

  beforeAll(async () => {
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    host = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    env = await createTestEnv({ connectorEncryptionKey: 'posthog-decision-test-key', outboundPolicy: { allowLocalHttp: true } });
  });

  afterAll(async () => {
    await env.close();
    await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
  });

  test('uses bounded external window aggregates and imports no raw events', async () => {
    const configured = await api(env, env.secretToken, 'POST', path(env, '/sources/posthog'), {
      name: 'decision_source', host, project_id: '42', personal_api_key: 'phx_decision_secret',
    });
    expect(configured.status).toBe(201);
    const sourceId = configured.body.id as string;
    const verified = await api(env, env.secretToken, 'POST', path(env, `/sources/posthog/${sourceId}/verify`), {});
    expect(verified.status).toBe(200);
    await activeMetric(env, {
      key: 'posthog_activation', type: 'unique_actors',
      purpose: 'Measures external activation evidence without importing the raw PostHog events.',
      source: {
        data_source: 'posthog', source_connection_id: sourceId,
        event: 'activation.completed', filters: [],
      },
    });
    const declaration = {
      version: 1,
      contracts: [{
        key: 'external_activation_change', name: 'External activation change',
        business_hypothesis: 'The deployed onboarding change should improve external activation.',
        decision_owner: 'growth-team', primary_metric_key: 'posthog_activation',
        guardrail_metric_keys: [], target_filters: [], baseline_window_days: 3,
        observation_window_days: 3, minimum_sample_size: 5,
        expected_direction: 'increase', minimum_meaningful_effect: 0.1,
        references: {}, status: 'active',
      }],
    };
    const diff = await api(env, env.secretToken, 'POST', path(env, '/contracts/diff'), declaration);
    await api(env, env.secretToken, 'POST', path(env, '/contracts/apply'), {
      declaration, expected_revision: diff.body.expected_revision,
    });
    const deployedAt = new Date(Date.now() - 4 * DAY);
    const release = await register(env, 'posthog-decision', 'external_activation_change', deployedAt);
    const evaluated = await api(env, env.secretToken, 'POST', path(env, `/releases/${release.id}/evaluate`), {});
    expect(evaluated.status).toBe(201);
    expect(evaluated.body.evidence).toMatchObject({
      source: 'posthog', ready: true, sample_size: 12,
      primary_evidence: {
        source: 'posthog', baseline: { value: 10, actors: 10 },
        observed: { value: 12, actors: 12 }, change: { absolute: 2, relative: 0.2 },
      },
    });
    expect(evaluated.body.decision.proposed_outcome).toBe('keep');
    const local = await env.pool.query(
      `SELECT count(*)::int AS count FROM events
       WHERE project_id = (SELECT id FROM projects WHERE slug = $1)`,
      [env.projectSlug],
    );
    expect(local.rows[0].count).toBe(0);
  });
});

function contract(key: string, minimumSampleSize: number) {
  return {
    key,
    name: key === 'shorter_onboarding' ? 'Shorter onboarding' : 'High-sample onboarding',
    business_hypothesis: 'Removing one setup step should increase first activation.',
    decision_owner: 'growth-team', primary_metric_key: 'activation_completed',
    guardrail_metric_keys: ['invite_completed'],
    target_filters: [{ property: 'plan', op: 'eq', value: 'pro' }],
    baseline_window_days: 3, observation_window_days: 3,
    minimum_sample_size: minimumSampleSize,
    expected_direction: 'increase', minimum_meaningful_effect: 0.1,
    references: {}, status: 'active',
  };
}

async function ingestWindowEvidence(env: TestEnv, anchor: Date, token: string, batchId: string) {
  const events: Array<Record<string, unknown>> = [];
  for (let index = 0; index < 10; index++) {
    events.push({
      event: 'activation.completed', distinct_id: `activation-baseline-${index}`,
      timestamp: new Date(anchor.getTime() - DAY).toISOString(), properties: { plan: 'pro' },
    });
    events.push({
      event: 'invite.completed', distinct_id: `invite-baseline-${index}`,
      timestamp: new Date(anchor.getTime() - DAY).toISOString(), properties: { plan: 'pro' },
    });
    events.push({
      event: 'invite.completed', distinct_id: `invite-observed-${index}`,
      timestamp: new Date(anchor.getTime() + DAY).toISOString(), properties: { plan: 'pro' },
    });
  }
  for (let index = 0; index < 15; index++) {
    events.push({
      event: 'activation.completed', distinct_id: `activation-observed-${index}`,
      timestamp: new Date(anchor.getTime() + DAY).toISOString(), properties: { plan: 'pro' },
    });
  }
  const ingested = await api(env, token, 'POST', '/i/v1/events', {
    batch_id: batchId, events,
  });
  expect(ingested.status).toBe(200);
}

async function register(
  env: TestEnv,
  key: string,
  contractKey: string,
  deployedAt: Date,
  releaseEnv = 'prod',
  experimentKey?: string,
) {
  const response = await api(env, env.secretToken, 'POST', path(env, '/releases'), {
    idempotency_key: key, contract_key: contractKey, env: releaseEnv,
    repository: 'acme/product', branch: 'main', commit_sha: key.padEnd(40, 'a').slice(0, 40).replace(/[^a-f0-9]/g, 'a'),
    deployed_at: deployedAt.toISOString(), status: 'deployed',
    ...(experimentKey ? { experiment_key: experimentKey } : {}),
  });
  expect(response.status).toBe(201);
  return response.body;
}

function path(env: TestEnv, suffix: string) {
  return `/api/v1/projects/${env.projectSlug}${suffix}`;
}

function routeEvaluationPostHog(
  req: IncomingMessage,
  res: ServerResponse,
  body: Record<string, unknown> | null,
) {
  res.setHeader('content-type', 'application/json');
  if (req.headers.authorization !== 'Bearer phx_decision_secret') {
    res.statusCode = 401;
    res.end(JSON.stringify({ detail: 'wrong credential' }));
    return;
  }
  if (req.url === '/api/projects/42/query/' && req.method === 'POST') {
    if (body?.name === 'poolstatis_connection_verify') {
      res.end(JSON.stringify({ columns: ['ok'], results: [[1]] }));
      return;
    }
    if (body?.name === 'poolstatis_evaluate_posthog_activation_baseline') {
      res.end(JSON.stringify({
        columns: ['value', 'events', 'actors', 'raw_actors', 'identified_events'],
        results: [[10, 10, 10, 10, 10]],
      }));
      return;
    }
    if (body?.name === 'poolstatis_evaluate_posthog_activation_observed') {
      res.end(JSON.stringify({
        columns: ['value', 'events', 'actors', 'raw_actors', 'identified_events'],
        results: [[12, 12, 12, 12, 12]],
      }));
      return;
    }
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ detail: 'fixture route not found' }));
}
