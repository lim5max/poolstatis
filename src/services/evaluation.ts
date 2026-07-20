import { createHash } from 'node:crypto';
import type pg from 'pg';
import { ApiError } from '../errors.js';
import type { MeasurementContractInput } from '../schemas.js';
import type { MetricAggregate } from '../stores/eventStore.js';
import type { QueryService } from './query.js';
import { validateDeclaration } from './contracts.js';
import { getRelease, transitionRelease, type Release } from './releases.js';

export type DecisionOutcome = 'keep' | 'fix' | 'rollback' | 'inconclusive';

export interface EvidenceBlocker {
  code: string;
  message: string;
  next_action: string;
}

export interface WindowEvidence {
  metric: { key: string; name: string; purpose: string; category: string | null; type: string };
  source: 'native' | 'posthog';
  baseline: MetricAggregate;
  observed: MetricAggregate;
  change: { absolute: number; relative: number | null };
}

export interface EvidenceSet {
  id: string;
  release_id: string;
  contract_id: string;
  evaluated_at: string;
  source: 'native' | 'posthog';
  baseline_window: { from: string; to: string };
  observed_window: { from: string; to: string };
  primary_evidence: WindowEvidence;
  guardrail_evidence: WindowEvidence[];
  trust: {
    status: 'trusted' | 'untrusted';
    registered_coverage: number;
    distinct_id_coverage: number;
    property_coverage: Record<string, number>;
    warnings: EvidenceBlocker[];
  };
  query_specs: Record<string, unknown>;
  facts: Record<string, unknown>;
  sample_size: number;
  ready: boolean;
  blockers: EvidenceBlocker[];
  evidence_key: string;
  created_at: string;
}

export interface ProposedDecision {
  id: string;
  release_id: string;
  contract_id: string;
  evidence_id: string;
  status: 'proposed' | 'approved' | 'rejected';
  proposed_outcome: DecisionOutcome;
  proposed_rationale: string;
  accepted_outcome: DecisionOutcome | null;
  accepted_rationale: string | null;
  current_revision: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

interface EvaluatedMetric {
  evidence: WindowEvidence;
  query: Record<string, unknown>;
}

const EMPTY_AGGREGATE: MetricAggregate = {
  value: 0,
  events: 0,
  actors: 0,
  rawActors: 0,
  registeredCoverage: 0,
  distinctIdCoverage: 0,
  propertyCoverage: {},
};

export async function evaluateRelease(
  pool: pg.Pool,
  query: QueryService,
  projectId: string,
  releaseId: string,
  actor: string,
  now: Date = new Date(),
): Promise<{ evidence: EvidenceSet; decision: ProposedDecision; idempotent: boolean }> {
  const release = (await getRelease(pool, projectId, releaseId)).release;
  if (release.status !== 'deployed' && release.status !== 'observing') {
    throw new ApiError(
      409,
      'release_not_evaluable',
      `release status=${release.status} cannot produce new evidence`,
      'register/deploy the release first; final and cancelled releases are immutable',
    );
  }
  if (!release.deployed_at) {
    throw new ApiError(409, 'release_missing_deployment', 'evaluation requires explicit deployed_at');
  }
  const contract = release.contract_snapshot;
  const deployedAt = new Date(release.deployed_at);
  const baselineFrom = new Date(deployedAt.getTime() - contract.baseline_window_days * 86_400_000);
  const observationPlannedTo = new Date(deployedAt.getTime() + contract.observation_window_days * 86_400_000);
  const observedTo = new Date(Math.min(now.getTime(), observationPlannedTo.getTime()));
  const baselineWindow = { from: baselineFrom.toISOString(), to: deployedAt.toISOString() };
  const observedWindow = { from: deployedAt.toISOString(), to: observedTo.toISOString() };
  const properties = [...new Set(contract.target_filters.map((filter) => filter.property))];
  const blockers: EvidenceBlocker[] = [];
  const warnings: EvidenceBlocker[] = [];

  const validation = await validateDeclaration(pool, projectId, { version: 1, contracts: [contract] });
  blockers.push(...validation.issues.map((item) => ({
    code: item.code,
    message: item.message,
    next_action: item.next_action,
  })));

  const primary = await evaluateMetric(
    query, projectId, release, contract.primary_metric_key, contract, properties,
    baselineFrom, deployedAt, observedTo, blockers,
  );
  const guardrails: EvaluatedMetric[] = [];
  for (const key of contract.guardrail_metric_keys) {
    guardrails.push(await evaluateMetric(
      query, projectId, release, key, contract, properties,
      baselineFrom, deployedAt, observedTo, blockers,
    ));
  }

  const aggregate = primary.evidence.observed;
  if (aggregate.events === 0) {
    blockers.push(blocker(
      'primary_metric_no_observations',
      'The observed window contains no primary metric evidence.',
      'Wait for real events or verify the external source mapping.',
    ));
  }
  if (aggregate.events > 0 && aggregate.registeredCoverage < 1) {
    blockers.push(blocker(
      'primary_metric_unregistered_evidence',
      'Some primary observations were not registered under an active metric.',
      'Repair the registry mapping and collect a clean evidence window.',
    ));
  }
  if (aggregate.events > 0 && aggregate.distinctIdCoverage < 0.9) {
    blockers.push(blocker(
      'distinct_id_coverage_low',
      `Stable actor coverage is ${percent(aggregate.distinctIdCoverage)}.`,
      'Instrument stable distinct_id values or add explicit actor links.',
    ));
  }
  for (const property of properties) {
    const coverage = aggregate.propertyCoverage[property] ?? 0;
    if (coverage < 0.9) {
      warnings.push(blocker(
        'target_property_coverage_low',
        `Target property "${property}" is present on ${percent(coverage)} of primary observations.`,
        'Check whether missing values bias this segment before approval.',
      ));
    }
  }
  const sampleRequirementMet = aggregate.actors >= contract.minimum_sample_size;
  if (!sampleRequirementMet) {
    blockers.push(blocker(
      'minimum_sample_not_reached',
      `Observed ${aggregate.actors} actors; the contract requires ${contract.minimum_sample_size}.`,
      'Wait for the declared sample size before making a directional decision.',
    ));
  }
  const observationComplete = now.getTime() >= observationPlannedTo.getTime();
  if (!observationComplete) {
    blockers.push(blocker(
      'observation_window_incomplete',
      `The ${contract.observation_window_days}-day observation window has not completed.`,
      `Wait until ${observationPlannedTo.toISOString()} and evaluate again.`,
    ));
  }

  const ready = blockers.length === 0;
  const primaryRelative = primary.evidence.change.relative;
  const guardrailRegression = guardrails.some((item) => {
    const relative = item.evidence.change.relative;
    return relative !== null && relative < -(contract.minimum_meaningful_effect ?? 0);
  });
  const outcome = proposeOutcome({
    ready,
    expectedDirection: contract.expected_direction,
    minimumEffect: contract.minimum_meaningful_effect ?? 0,
    primaryRelative,
    guardrailRegression,
  });
  const rationale = decisionRationale(outcome, primary.evidence, guardrailRegression, blockers);
  const trust = {
    status: blockers.some((item) => trustBlocker(item.code)) ? 'untrusted' as const : 'trusted' as const,
    registered_coverage: aggregate.registeredCoverage,
    distinct_id_coverage: aggregate.distinctIdCoverage,
    property_coverage: aggregate.propertyCoverage,
    warnings,
  };
  const querySpecs = {
    primary: primary.query,
    guardrails: Object.fromEntries(guardrails.map((item) => [item.evidence.metric.key, item.query])),
  };
  const facts = {
    expected_direction: contract.expected_direction,
    minimum_meaningful_effect: contract.minimum_meaningful_effect ?? 0,
    minimum_sample_size: contract.minimum_sample_size,
    observation_complete: observationComplete,
    sample_requirement_met: sampleRequirementMet,
    guardrail_regression: guardrailRegression,
  };
  const evidenceKey = sha256({
    release_id: release.id,
    contract_revision: release.contract_revision,
    baseline_window: baselineWindow,
    observed_window: observedWindow,
    primary: primary.evidence,
    guardrails: guardrails.map((item) => item.evidence),
    blockers,
  });

  if (ready && release.status === 'deployed') {
    await transitionRelease(pool, projectId, release.id, { status: 'observing' }, actor, now);
  }
  return persistEvaluation(pool, projectId, release, {
    evaluatedAt: now,
    baselineWindow,
    observedWindow,
    primary: primary.evidence,
    guardrails: guardrails.map((item) => item.evidence),
    trust,
    querySpecs,
    facts,
    sampleSize: aggregate.actors,
    ready,
    blockers,
    evidenceKey,
    outcome,
    rationale,
    actor,
  });
}

export function proposeOutcome(input: {
  ready: boolean;
  expectedDirection: MeasurementContractInput['expected_direction'];
  minimumEffect: number;
  primaryRelative: number | null;
  guardrailRegression: boolean;
}): DecisionOutcome {
  if (!input.ready || input.primaryRelative === null) return 'inconclusive';
  if (input.guardrailRegression) return 'fix';
  if (input.expectedDirection === 'stay_within_range') {
    return Math.abs(input.primaryRelative) <= input.minimumEffect ? 'keep' : 'fix';
  }
  const aligned = input.expectedDirection === 'increase'
    ? input.primaryRelative
    : -input.primaryRelative;
  if (aligned >= input.minimumEffect) return 'keep';
  if (aligned <= -input.minimumEffect) return 'rollback';
  return 'fix';
}

async function evaluateMetric(
  query: QueryService,
  projectId: string,
  release: Release,
  metricKey: string,
  contract: MeasurementContractInput,
  properties: string[],
  baselineFrom: Date,
  deployedAt: Date,
  observedTo: Date,
  blockers: EvidenceBlocker[],
): Promise<EvaluatedMetric> {
  try {
    const [baseline, observed] = await Promise.all([
      query.aggregateMetricWindow(projectId, {
        metricKey, env: release.env, filters: contract.target_filters,
        properties, from: baselineFrom, to: deployedAt, windowName: 'baseline',
      }),
      query.aggregateMetricWindow(projectId, {
        metricKey, env: release.env, filters: contract.target_filters,
        properties, from: deployedAt, to: observedTo, windowName: 'observed',
      }),
    ]);
    const absolute = observed.result.value - baseline.result.value;
    const relative = baseline.result.value === 0
      ? null
      : Number((absolute / Math.abs(baseline.result.value)).toFixed(6));
    return {
      evidence: {
        metric: baseline.metric,
        source: baseline.source,
        baseline: baseline.result,
        observed: observed.result,
        change: { absolute, relative },
      },
      query: {
        baseline: { query: baseline.query, aggregation: baseline.aggregation },
        observed: { query: observed.query, aggregation: observed.aggregation },
      },
    };
  } catch (error) {
    blockers.push(blocker(
      'metric_evaluation_failed',
      `Metric "${metricKey}" could not be evaluated: ${error instanceof Error ? error.message : 'unknown error'}`,
      'Repair the metric/source and evaluate again.',
    ));
    return {
      evidence: {
        metric: { key: metricKey, name: metricKey, purpose: 'Unavailable metric evidence.', category: null, type: 'unknown' },
        source: 'native',
        baseline: EMPTY_AGGREGATE,
        observed: EMPTY_AGGREGATE,
        change: { absolute: 0, relative: null },
      },
      query: {},
    };
  }
}

async function persistEvaluation(
  pool: pg.Pool,
  projectId: string,
  release: Release,
  input: {
    evaluatedAt: Date;
    baselineWindow: { from: string; to: string };
    observedWindow: { from: string; to: string };
    primary: WindowEvidence;
    guardrails: WindowEvidence[];
    trust: EvidenceSet['trust'];
    querySpecs: Record<string, unknown>;
    facts: Record<string, unknown>;
    sampleSize: number;
    ready: boolean;
    blockers: EvidenceBlocker[];
    evidenceKey: string;
    outcome: DecisionOutcome;
    rationale: string;
    actor: string;
  },
): Promise<{ evidence: EvidenceSet; decision: ProposedDecision; idempotent: boolean }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query<Record<string, any>>(
      `INSERT INTO evidence_sets (
         project_id, release_id, contract_id, evaluated_at, source,
         baseline_window, observed_window, primary_evidence, guardrail_evidence,
         trust, query_specs, facts, sample_size, ready, blockers, evidence_key
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       ON CONFLICT (project_id, release_id, evidence_key) DO NOTHING
       RETURNING *`,
      [
        projectId, release.id, release.contract_id, input.evaluatedAt,
        input.primary.source, JSON.stringify(input.baselineWindow),
        JSON.stringify(input.observedWindow), JSON.stringify(input.primary),
        JSON.stringify(input.guardrails), JSON.stringify(input.trust),
        JSON.stringify(input.querySpecs), JSON.stringify(input.facts),
        input.sampleSize, input.ready, JSON.stringify(input.blockers), input.evidenceKey,
      ],
    );
    if (!inserted.rows[0]) {
      const existing = await client.query<Record<string, any>>(
        `SELECT e.*, d.id AS decision_id
         FROM evidence_sets e JOIN decisions d ON d.evidence_id = e.id
         WHERE e.project_id = $1 AND e.release_id = $2 AND e.evidence_key = $3`,
        [projectId, release.id, input.evidenceKey],
      );
      const evidence = rowToEvidence(existing.rows[0]!);
      const decision = await readDecision(client, projectId, existing.rows[0]!.decision_id);
      await client.query('COMMIT');
      return { evidence, decision, idempotent: true };
    }
    const evidence = rowToEvidence(inserted.rows[0]);
    const created = await client.query<Record<string, any>>(
      `INSERT INTO decisions (
         project_id, release_id, contract_id, evidence_id,
         proposed_outcome, proposed_rationale, created_by
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [projectId, release.id, release.contract_id, evidence.id, input.outcome, input.rationale, input.actor],
    );
    const decision = rowToDecision(created.rows[0]!);
    await client.query(
      `INSERT INTO decision_revisions (
         decision_id, project_id, revision, action, actor, previous_snapshot, snapshot, rationale
       ) VALUES ($1, $2, 1, 'proposed', $3, NULL, $4, $5)`,
      [decision.id, projectId, input.actor, JSON.stringify(decision), input.rationale],
    );
    await client.query('COMMIT');
    return { evidence, decision, idempotent: false };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export function rowToEvidence(row: Record<string, any>): EvidenceSet {
  return {
    id: row.id,
    release_id: row.release_id,
    contract_id: row.contract_id,
    evaluated_at: iso(row.evaluated_at),
    source: row.source,
    baseline_window: row.baseline_window,
    observed_window: row.observed_window,
    primary_evidence: row.primary_evidence,
    guardrail_evidence: row.guardrail_evidence,
    trust: row.trust,
    query_specs: row.query_specs,
    facts: row.facts,
    sample_size: row.sample_size,
    ready: row.ready,
    blockers: row.blockers,
    evidence_key: row.evidence_key,
    created_at: iso(row.created_at),
  };
}

export function rowToDecision(row: Record<string, any>): ProposedDecision {
  return {
    id: row.id,
    release_id: row.release_id,
    contract_id: row.contract_id,
    evidence_id: row.evidence_id,
    status: row.status,
    proposed_outcome: row.proposed_outcome,
    proposed_rationale: row.proposed_rationale,
    accepted_outcome: row.accepted_outcome,
    accepted_rationale: row.accepted_rationale,
    current_revision: row.current_revision,
    created_by: row.created_by,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
}

async function readDecision(
  pool: pg.PoolClient,
  projectId: string,
  id: string,
): Promise<ProposedDecision> {
  const { rows } = await pool.query(
    'SELECT * FROM decisions WHERE project_id = $1 AND id = $2',
    [projectId, id],
  );
  return rowToDecision(rows[0]!);
}

function decisionRationale(
  outcome: DecisionOutcome,
  primary: WindowEvidence,
  guardrailRegression: boolean,
  blockers: EvidenceBlocker[],
): string {
  if (outcome === 'inconclusive') {
    return `Evidence is inconclusive: ${blockers.map((item) => item.message).join(' ')}`;
  }
  const relative = primary.change.relative ?? 0;
  const movement = `${relative >= 0 ? '+' : ''}${Math.round(relative * 100)}%`;
  if (guardrailRegression) {
    return `${primary.metric.name} moved ${movement}, but a declared guardrail regressed; fix the change before keeping it.`;
  }
  if (outcome === 'keep') return `${primary.metric.name} moved ${movement} and cleared the declared threshold without guardrail regression.`;
  if (outcome === 'rollback') return `${primary.metric.name} moved ${movement} against the declared direction; rollback is the safest proposal.`;
  return `${primary.metric.name} moved ${movement} but did not clear the declared outcome threshold; inspect and fix before deciding.`;
}

function trustBlocker(code: string): boolean {
  return code.includes('untrusted')
    || code.includes('inactive')
    || code.includes('incompatible')
    || code.includes('unknown_')
    || code.includes('registered')
    || code.includes('distinct_id')
    || code === 'metric_evaluation_failed';
}

function blocker(code: string, message: string, nextAction: string): EvidenceBlocker {
  return { code, message, next_action: nextAction };
}

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
