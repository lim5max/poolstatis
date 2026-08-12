import type pg from 'pg';
import { generateToken, type KeyKind } from '../keys.js';
import { ApiError, notFound } from '../errors.js';
import type { EventStore } from '../stores/eventStore.js';
import { listActiveContractsBounded } from './contracts.js';
import type { QueryService } from './query.js';

export interface Project {
  id: string;
  org_id: string;
  slug: string;
  name: string;
  timezone: string;
  retention_months: number;
}

export type CreateApiKeyInput =
  | { orgId: string; projectId: null; kind: 'personal'; env?: string; label?: string; issuedByUserId: string; legacySelfHost?: never }
  | { orgId: string; projectId: null; kind: 'personal'; env?: string; label?: string; legacySelfHost: true; issuedByUserId?: never }
  | { orgId: string; projectId: string; kind: 'ingest' | 'secret'; env?: string; label?: string; issuedByUserId?: never };

export async function createOrganization(pool: pg.Pool, name: string): Promise<{ id: string }> {
  const { rows } = await pool.query(
    'INSERT INTO organizations (name) VALUES ($1) RETURNING id',
    [name],
  );
  return { id: rows[0].id };
}

export async function createProject(
  pool: pg.Pool,
  orgId: string,
  slug: string,
  name: string,
): Promise<Project> {
  const { rows } = await pool.query(
    `INSERT INTO projects (org_id, slug, name) VALUES ($1, $2, $3)
     RETURNING id, org_id, slug, name, timezone, retention_months`,
    [orgId, slug, name],
  );
  return rows[0];
}

export async function deleteProject(
  pool: pg.Pool,
  orgId: string,
  slug: string,
): Promise<Project> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<Project>(
      `SELECT id, org_id, slug, name, timezone, retention_months
       FROM projects
       WHERE org_id = $1 AND slug = $2
       FOR UPDATE`,
      [orgId, slug],
    );
    const project = rows[0];
    if (!project) throw notFound('project', `no project with slug "${slug}" in this organization`);
    const deleted = await client.query(
      'DELETE FROM projects WHERE org_id = $1 AND id = $2',
      [orgId, project.id],
    );
    if (deleted.rowCount !== 1) throw notFound('project');
    await client.query('COMMIT');
    return project;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function createApiKey(
  pool: pg.Pool,
  opts: CreateApiKeyInput,
): Promise<{ id: string; token: string }> {
  if (opts.kind !== 'personal' && 'issuedByUserId' in opts && opts.issuedByUserId !== undefined) {
    throw new Error('issuedByUserId is only valid for personal keys');
  }
  if (opts.kind === 'personal' && !opts.issuedByUserId && opts.legacySelfHost !== true) {
    throw new Error('personal keys require issuedByUserId unless legacySelfHost is explicitly enabled');
  }
  const { token, hash } = generateToken(opts.kind);
  const { rows } = await pool.query(
    `INSERT INTO api_keys (
       org_id, project_id, kind, env, token_hash, label,
       issued_by_user_id, token_prefix, token_suffix
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [
      opts.orgId, opts.projectId, opts.kind, opts.env ?? 'prod', hash, opts.label ?? null,
      opts.issuedByUserId ?? null, `${token.slice(0, 3)}`, token.slice(-4),
    ],
  );
  return { id: rows[0].id, token };
}

export interface ApiKeyRow {
  id: string;
  kind: KeyKind;
  env: string;
  label: string | null;
  masked_token: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  credential_policy: CredentialRotationPolicy;
  rotation_recommendation: CredentialRotationRecommendation;
}

export interface PersonalApiKeyRow {
  id: string;
  label: string | null;
  token: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  credential_policy: CredentialRotationPolicy;
  rotation_recommendation: CredentialRotationRecommendation;
}

export interface CredentialRotationPolicy {
  id: 'poolstatis_core.credential_rotation';
  version: 1;
  source: 'poolstatis_core_default';
  mode: 'advisory';
  thresholds: {
    age_review_days: 180;
    idle_review_days: 30;
    unused_review_days: 7;
  };
}

export interface CredentialRotationRecommendation {
  status: 'healthy' | 'review' | 'revoked';
  code: 'active' | 'new' | 'age_review' | 'idle_review' | 'unused_review' | 'revoked';
  label: string;
  recommendation: string;
  evaluated_at: string;
  evidence: { age_days: number; idle_days: number | null };
}

export const CORE_CREDENTIAL_ROTATION_POLICY: CredentialRotationPolicy = {
  id: 'poolstatis_core.credential_rotation',
  version: 1,
  source: 'poolstatis_core_default',
  mode: 'advisory',
  thresholds: {
    age_review_days: 180,
    idle_review_days: 30,
    unused_review_days: 7,
  },
};

export function evaluateCredentialRotation(
  item: { created_at: string | Date; last_used_at: string | Date | null; revoked_at: string | Date | null },
  evaluatedAt = new Date(),
): CredentialRotationRecommendation {
  const ageDays = elapsedWholeDays(evaluatedAt, item.created_at);
  const idleDays = item.last_used_at ? elapsedWholeDays(evaluatedAt, item.last_used_at) : null;
  const evidence = { age_days: ageDays, idle_days: idleDays };
  const evaluated_at = evaluatedAt.toISOString();

  if (item.revoked_at) {
    return {
      status: 'revoked', code: 'revoked', label: 'Revoked', evaluated_at, evidence,
      recommendation: 'Audit retained; this credential cannot authenticate.',
    };
  }
  if (ageDays >= CORE_CREDENTIAL_ROTATION_POLICY.thresholds.age_review_days) {
    return {
      status: 'review', code: 'age_review', label: 'Review age', evaluated_at, evidence,
      recommendation: 'Core advisory age threshold reached. Create and verify a replacement before revoking this key.',
    };
  }
  if (idleDays !== null && idleDays >= CORE_CREDENTIAL_ROTATION_POLICY.thresholds.idle_review_days) {
    return {
      status: 'review', code: 'idle_review', label: 'Review access', evaluated_at, evidence,
      recommendation: 'Core advisory inactivity threshold reached. Confirm the owner and revoke if this integration is abandoned.',
    };
  }
  if (idleDays === null && ageDays >= CORE_CREDENTIAL_ROTATION_POLICY.thresholds.unused_review_days) {
    return {
      status: 'review', code: 'unused_review', label: 'Never used', evaluated_at, evidence,
      recommendation: 'Core advisory unused threshold reached. Verify the intended owner or revoke the unused key.',
    };
  }
  return item.last_used_at
    ? {
        status: 'healthy', code: 'active', label: 'Healthy', evaluated_at, evidence,
        recommendation: 'No Core advisory rotation signal from age or activity.',
      }
    : {
        status: 'healthy', code: 'new', label: 'Ready', evaluated_at, evidence,
        recommendation: 'New credential; verify it before revoking any predecessor.',
      };
}

function elapsedWholeDays(now: Date, value: string | Date): number {
  return Math.max(0, Math.floor((now.getTime() - new Date(value).getTime()) / 86_400_000));
}

/** Personal credentials are scoped to their issuing hosted user and never reveal plaintext. */
export async function listPersonalApiKeys(
  pool: pg.Pool,
  orgId: string,
  userId: string,
): Promise<PersonalApiKeyRow[]> {
  const { rows } = await pool.query(
    `SELECT id, label, token_prefix, token_suffix, created_at, last_used_at, revoked_at
     FROM api_keys
     WHERE org_id = $1 AND issued_by_user_id = $2 AND kind = 'personal'
     ORDER BY created_at DESC`,
    [orgId, userId],
  );
  const evaluatedAt = new Date();
  return rows.map((row) => ({
    id: row.id,
    label: row.label,
    token: row.token_suffix ? `${row.token_prefix ?? 'pt_'}...${row.token_suffix}` : `${row.token_prefix ?? 'pt_'}...`,
    created_at: row.created_at,
    last_used_at: row.last_used_at,
    revoked_at: row.revoked_at,
    credential_policy: CORE_CREDENTIAL_ROTATION_POLICY,
    rotation_recommendation: evaluateCredentialRotation(row, evaluatedAt),
  }));
}

export async function revokePersonalApiKey(
  pool: pg.Pool,
  orgId: string,
  userId: string,
  id: string,
): Promise<void> {
  const { rowCount } = await pool.query(
    `UPDATE api_keys SET revoked_at = now()
     WHERE id = $1 AND org_id = $2 AND issued_by_user_id = $3
       AND kind = 'personal' AND revoked_at IS NULL`,
    [id, orgId, userId],
  );
  if (!rowCount) throw notFound('api_key', 'no active personal token with that id in this organization');
}

/** Keys for a project, masked — the token itself is shown only once at creation. */
export async function listApiKeys(pool: pg.Pool, projectId: string): Promise<ApiKeyRow[]> {
  const { rows } = await pool.query(
    `SELECT id, kind, env, label, token_prefix, token_suffix, created_at, last_used_at, revoked_at
     FROM api_keys WHERE project_id = $1 ORDER BY created_at DESC`,
    [projectId],
  );
  const evaluatedAt = new Date();
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    env: row.env,
    label: row.label,
    masked_token: row.token_suffix
      ? `${row.token_prefix ?? (row.kind === 'ingest' ? 'pk_' : 'sk_')}...${row.token_suffix}`
      : `${row.token_prefix ?? (row.kind === 'ingest' ? 'pk_' : 'sk_')}...`,
    created_at: row.created_at,
    last_used_at: row.last_used_at,
    revoked_at: row.revoked_at,
    credential_policy: CORE_CREDENTIAL_ROTATION_POLICY,
    rotation_recommendation: evaluateCredentialRotation(row, evaluatedAt),
  }));
}

export async function revokeApiKey(
  pool: pg.Pool,
  orgId: string,
  id: string,
  projectId: string,
): Promise<void> {
  // Scope to project_id as well as org_id: a secret key pinned to one project
  // must not be able to revoke another project's key in the same org.
  const { rowCount } = await pool.query(
    `UPDATE api_keys SET revoked_at = now()
     WHERE id = $1 AND org_id = $2 AND project_id = $3 AND revoked_at IS NULL`,
    [id, orgId, projectId],
  );
  if (!rowCount) throw notFound('api_key', 'no active key with that id in this project');
}

export interface ProjectWithStats extends Pick<Project, 'slug' | 'name' | 'timezone'> {
  active_metrics: number;
  proposed_metrics: number;
  active_outcome_contracts: number;
  funnels: number;
  events_24h: number;
  events_7d: number;
  events_30d: number;
  last_event_at: string | null;
  registered_coverage_30d: number | null;
  key_outcome_available: boolean;
  key_outcome_readiness: KeyOutcomeReadiness;
  health: 'healthy' | 'needs_attention' | 'no_data';
  attention: string[];
  health_evaluation: ProjectHealthEvaluation;
}

export interface KeyOutcomeReadiness {
  state: 'ready' | 'unavailable';
  contract_key: string | null;
  metric_key: string | null;
  evaluated_at: string;
  guardrail: {
    id: 'key_outcome_queryable';
    state: 'pass' | 'fail';
    reason_code:
      | 'query_succeeded'
      | 'no_active_contract'
      | 'no_queryable_outcome'
      | 'outcome_query_failed'
      | 'external_environment_scope_unverified'
      | 'contract_selection_bounded'
      | 'environment_scope_required';
    reason: string;
    observed_events: number | null;
  };
}

export interface ProjectPortfolioRow extends ProjectWithStats {
  environment: string;
  current_usage: {
    meter: 'events_stored';
    period: string;
    accepted_events: number;
    last_ingest_at: string | null;
    source: 'usage_ledger';
    basis: 'ingest_time';
  };
}

export interface ProjectPortfolioResult {
  schema_version: 1;
  generated_at: string;
  scope: {
    credential: 'organization' | 'project';
    environment: string;
    usage_cycle: { from: string; to: string; timezone: 'UTC'; basis: 'ingest_time' };
  };
  projects: ProjectPortfolioRow[];
}

export interface ProjectHealthEvaluation {
  source: 'server';
  evaluated_at: string;
  guardrails: Array<{
    id: 'recent_data' | 'registered_coverage' | 'active_outcome' | 'key_outcome_queryable' | 'metric_review_queue';
    state: 'pass' | 'fail' | 'not_applicable';
    observed: number | null;
    expectation: string;
  }>;
}

export const PORTFOLIO_PROJECT_CONCURRENCY = 4;
export const KEY_OUTCOME_CONTRACT_LIMIT = 5;

export function evaluateProjectHealth(input: {
  events30d: number;
  registeredCoverage30d: number | null;
  activeOutcomeContracts: number;
  proposedMetrics: number;
  keyOutcomeReadiness?: KeyOutcomeReadiness;
}, evaluatedAt = new Date()): Pick<ProjectWithStats, 'health' | 'attention' | 'health_evaluation'> {
  const outcomeScoped = input.keyOutcomeReadiness !== undefined;
  const outcomeReady = input.keyOutcomeReadiness?.state === 'ready';
  const guardrails: ProjectHealthEvaluation['guardrails'] = [
    {
      id: 'recent_data',
      state: input.events30d > 0 ? 'pass' : 'fail',
      observed: input.events30d,
      expectation: 'More than 0 accepted events in 30 days',
    },
    {
      id: 'registered_coverage',
      state: input.registeredCoverage30d === null
        ? 'not_applicable'
        : input.registeredCoverage30d >= 0.99 ? 'pass' : 'fail',
      observed: input.registeredCoverage30d,
      expectation: 'Registered coverage is at least 99%',
    },
    {
      id: outcomeScoped ? 'key_outcome_queryable' : 'active_outcome',
      state: outcomeScoped ? (outcomeReady ? 'pass' : 'fail') : input.activeOutcomeContracts > 0 ? 'pass' : 'fail',
      observed: outcomeScoped ? (outcomeReady ? 1 : 0) : input.activeOutcomeContracts,
      expectation: outcomeScoped
        ? 'At least 1 active outcome passes the typed 30-day query guardrail'
        : 'At least 1 active measurement contract',
    },
    {
      id: 'metric_review_queue',
      state: input.proposedMetrics === 0 ? 'pass' : 'fail',
      observed: input.proposedMetrics,
      expectation: 'No proposed metrics awaiting review',
    },
  ];
  const attention: string[] = [];
  if (guardrails[0]!.state === 'fail') attention.push('No events in 30 days');
  if (guardrails[2]!.state === 'fail') {
    attention.push(outcomeScoped ? 'Key outcome is not queryable' : 'No active measurement contract');
  }
  if (guardrails[1]!.state === 'fail') attention.push('Off-standard event volume');
  if (guardrails[3]!.state === 'fail') {
    attention.push(`${input.proposedMetrics} metric${input.proposedMetrics === 1 ? '' : 's'} awaiting review`);
  }
  return {
    health: input.events30d === 0 ? 'no_data' : attention.length > 0 ? 'needs_attention' : 'healthy',
    attention,
    health_evaluation: {
      source: 'server',
      evaluated_at: evaluatedAt.toISOString(),
      guardrails,
    },
  };
}

export async function listProjectsWithStats(
  pool: pg.Pool,
  eventStore: EventStore,
  orgId: string,
  options: {
    env?: string;
    projectId?: string;
    evaluatedAt?: Date;
    outcomeReadinessEvaluator?: (projectId: string) => Promise<KeyOutcomeReadiness>;
  } = {},
): Promise<ProjectWithStats[]> {
  const params: unknown[] = [orgId];
  const projectPredicate = options.projectId === undefined
    ? ''
    : ` AND p.id = $${params.push(options.projectId)}`;
  const { rows } = await pool.query(
    `SELECT p.id, p.slug, p.name, p.timezone,
       metric_stats.active_metrics,
       metric_stats.proposed_metrics,
       funnel_stats.funnels,
       contract_stats.active_outcome_contracts
     FROM projects p
     CROSS JOIN LATERAL (
       SELECT
         count(*) FILTER (WHERE status = 'active')::int AS active_metrics,
         count(*) FILTER (WHERE status = 'proposed')::int AS proposed_metrics
       FROM metrics WHERE project_id = p.id
     ) metric_stats
     CROSS JOIN LATERAL (
       SELECT count(*)::int AS funnels FROM funnels WHERE project_id = p.id
     ) funnel_stats
     CROSS JOIN LATERAL (
       SELECT count(*) FILTER (WHERE status = 'active')::int AS active_outcome_contracts
       FROM measurement_contracts WHERE project_id = p.id
     ) contract_stats
     WHERE p.org_id = $1${projectPredicate} ORDER BY p.created_at`,
    params,
  );
  const eventStats = new Map(
    (await eventStore.projectPortfolioStats(rows.map((row) => row.id as string), options.env))
      .map((stats) => [stats.project_id, stats]),
  );
  const evaluatedAt = options.evaluatedAt ?? new Date();
  return mapWithConcurrency(rows, PORTFOLIO_PROJECT_CONCURRENCY, async (row) => {
    const activeMetrics = Number(row.active_metrics);
    const proposedMetrics = Number(row.proposed_metrics);
    const activeOutcomeContracts = Number(row.active_outcome_contracts);
    const events = eventStats.get(row.id) ?? {
      events_24h: 0,
      events_7d: 0,
      events_30d: 0,
      registered_events_30d: 0,
      last_event_at: null,
    };
    const events30d = events.events_30d;
    const coverage = events30d === 0 ? null : events.registered_events_30d / events30d;
    const keyOutcomeReadiness = options.outcomeReadinessEvaluator
      ? await options.outcomeReadinessEvaluator(row.id as string)
      : unscopedKeyOutcomeReadiness(evaluatedAt);
    const evaluatedHealth = evaluateProjectHealth({
      events30d,
      registeredCoverage30d: coverage,
      activeOutcomeContracts,
      proposedMetrics,
      ...(options.outcomeReadinessEvaluator ? { keyOutcomeReadiness } : {}),
    }, evaluatedAt);
    return {
      slug: row.slug,
      name: row.name,
      timezone: row.timezone,
      active_metrics: activeMetrics,
      proposed_metrics: proposedMetrics,
      active_outcome_contracts: activeOutcomeContracts,
      funnels: Number(row.funnels),
      events_24h: events.events_24h,
      events_7d: events.events_7d,
      events_30d: events30d,
      last_event_at: events.last_event_at,
      registered_coverage_30d: coverage,
      key_outcome_available: keyOutcomeReadiness.state === 'ready',
      key_outcome_readiness: keyOutcomeReadiness,
      ...evaluatedHealth,
    };
  });
}

export function unscopedKeyOutcomeReadiness(evaluatedAt = new Date()): KeyOutcomeReadiness {
  return {
    state: 'unavailable',
    contract_key: null,
    metric_key: null,
    evaluated_at: evaluatedAt.toISOString(),
    guardrail: {
      id: 'key_outcome_queryable',
      state: 'fail',
      reason_code: 'environment_scope_required',
      reason: 'Choose an environment before evaluating the typed key-outcome query.',
      observed_events: null,
    },
  };
}

export async function evaluateKeyOutcomeReadiness(
  pool: pg.Pool,
  query: QueryService,
  projectId: string,
  env: string,
  evaluatedAt = new Date(),
): Promise<KeyOutcomeReadiness> {
  const selection = await listActiveContractsBounded(pool, projectId, KEY_OUTCOME_CONTRACT_LIMIT);
  const contracts = selection.contracts;
  if (contracts.length === 0) {
    return unavailableKeyOutcomeReadiness(
      evaluatedAt,
      'no_active_contract',
      'No active measurement contract selects a key outcome for this project.',
    );
  }
  const sourceRows = await pool.query<{ key: string; source: Record<string, unknown> }>(
    `SELECT key, source FROM metrics
     WHERE project_id = $1 AND key = ANY($2::text[])`,
    [projectId, contracts.map((contract) => contract.primary_metric_key)],
  );
  const metricSources = new Map(sourceRows.rows.map((metric) => [metric.key, metric.source]));
  const from = new Date(evaluatedAt.getTime() - 30 * 86_400_000);
  let unexpectedFailure = false;
  let externalWithoutEnvironmentScope = 0;
  for (const contract of contracts) {
    const source = metricSources.get(contract.primary_metric_key);
    if (source?.data_source === 'posthog') {
      // Source connections currently prove a PostHog project, not a trusted
      // mapping from a Poolstatis environment to a PostHog environment.
      externalWithoutEnvironmentScope += 1;
      continue;
    }
    try {
      const result = await query.aggregateMetricWindow(projectId, {
        metricKey: contract.primary_metric_key,
        env,
        filters: contract.target_filters,
        properties: [...new Set(contract.target_filters.map((filter) => filter.property))],
        from,
        to: evaluatedAt,
        windowName: 'observed',
      });
      return {
        state: 'ready',
        contract_key: contract.key,
        metric_key: contract.primary_metric_key,
        evaluated_at: evaluatedAt.toISOString(),
        guardrail: {
          id: 'key_outcome_queryable',
          state: 'pass',
          reason_code: 'query_succeeded',
          reason: `The typed 30-day outcome query completed for ${env}.`,
          observed_events: result.result.events,
        },
      };
    } catch (error) {
      if (!(error instanceof ApiError) || error.statusCode >= 500) unexpectedFailure = true;
    }
  }
  if (selection.truncated) {
    return unavailableKeyOutcomeReadiness(
      evaluatedAt,
      'contract_selection_bounded',
      `Only the first ${KEY_OUTCOME_CONTRACT_LIMIT} active contracts in key order were evaluated. Narrow or archive the contract set before using portfolio readiness.`,
    );
  }
  if (externalWithoutEnvironmentScope > 0 && !unexpectedFailure) {
    return unavailableKeyOutcomeReadiness(
      evaluatedAt,
      'external_environment_scope_unverified',
      `The selected ${env} environment is not mapped to a trusted PostHog environment, so this outcome is unavailable for environment-scoped portfolio status.`,
    );
  }
  return unavailableKeyOutcomeReadiness(
    evaluatedAt,
    unexpectedFailure ? 'outcome_query_failed' : 'no_queryable_outcome',
    unexpectedFailure
      ? 'The typed outcome query could not be evaluated. Retry before using this outcome.'
      : 'No active contract passed the typed outcome query guardrail. Review its metric and source.',
  );
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(values[index]!, index);
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(Math.max(1, concurrency), values.length) },
    () => worker(),
  ));
  return results;
}

function unavailableKeyOutcomeReadiness(
  evaluatedAt: Date,
  reasonCode: KeyOutcomeReadiness['guardrail']['reason_code'],
  reason: string,
): KeyOutcomeReadiness {
  return {
    state: 'unavailable',
    contract_key: null,
    metric_key: null,
    evaluated_at: evaluatedAt.toISOString(),
    guardrail: {
      id: 'key_outcome_queryable',
      state: 'fail',
      reason_code: reasonCode,
      reason,
      observed_events: null,
    },
  };
}

function safeUsageQuantity(value: string | number): number {
  const quantity = Number(value);
  if (!Number.isSafeInteger(quantity) || quantity < 0) {
    throw new Error('portfolio usage cannot be represented as a non-negative safe integer');
  }
  return quantity;
}

export async function getProjectPortfolio(
  pool: pg.Pool,
  eventStore: EventStore,
  query: QueryService,
  orgId: string,
  env: string,
  credential: 'organization' | 'project',
  projectId?: string,
  now = new Date(),
): Promise<ProjectPortfolioResult> {
  const cycleFrom = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const cycleTo = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const period = cycleFrom.toISOString().slice(0, 7);
  const projects = await listProjectsWithStats(pool, eventStore, orgId, {
    env,
    ...(projectId ? { projectId } : {}),
    evaluatedAt: now,
    outcomeReadinessEvaluator: (scopedProjectId) => evaluateKeyOutcomeReadiness(
      pool,
      query,
      scopedProjectId,
      env,
      now,
    ),
  });
  const usageParams: unknown[] = [orgId, env, cycleFrom.toISOString().slice(0, 10)];
  const projectPredicate = projectId === undefined
    ? ''
    : ` AND l.project_id = $${usageParams.push(projectId)}`;
  const usage = await pool.query<{
    project_slug: string;
    quantity: string;
    last_ingest_at: Date | string;
  }>(
    `SELECT p.slug AS project_slug, sum(l.quantity)::bigint::text AS quantity, max(l.ingested_at) AS last_ingest_at
     FROM usage_ledger l
     JOIN projects p ON p.org_id = l.org_id AND p.id = l.project_id
     WHERE l.org_id = $1 AND l.env = $2 AND l.meter_key = 'events_stored'
       AND l.period_start = $3::date${projectPredicate}
     GROUP BY p.slug`,
    usageParams,
  );
  const usageByProject = new Map(usage.rows.map((row) => [row.project_slug, row]));

  return {
    schema_version: 1,
    generated_at: now.toISOString(),
    scope: {
      credential,
      environment: env,
      usage_cycle: {
        from: cycleFrom.toISOString(),
        to: cycleTo.toISOString(),
        timezone: 'UTC',
        basis: 'ingest_time',
      },
    },
    projects: projects.map((project) => {
      const usageRow = usageByProject.get(project.slug);
      return {
        ...project,
        environment: env,
        current_usage: {
          meter: 'events_stored',
          period,
          accepted_events: safeUsageQuantity(usageRow?.quantity ?? '0'),
          last_ingest_at: usageRow ? new Date(usageRow.last_ingest_at).toISOString() : null,
          source: 'usage_ledger',
          basis: 'ingest_time',
        },
      };
    }),
  };
}

export async function getProjectBySlug(
  pool: pg.Pool,
  orgId: string,
  slug: string,
): Promise<Project> {
  const { rows } = await pool.query(
    `SELECT id, org_id, slug, name, timezone, retention_months
     FROM projects WHERE org_id = $1 AND slug = $2`,
    [orgId, slug],
  );
  if (!rows[0]) {
    throw notFound('project', `no project with slug "${slug}" in this organization — call list_projects`);
  }
  return rows[0];
}

export async function listProjects(pool: pg.Pool, orgId: string): Promise<Project[]> {
  const { rows } = await pool.query(
    `SELECT id, org_id, slug, name, timezone, retention_months
     FROM projects WHERE org_id = $1 ORDER BY created_at`,
    [orgId],
  );
  return rows;
}
