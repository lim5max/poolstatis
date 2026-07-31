import type pg from 'pg';
import type { EventStore } from '../stores/eventStore.js';
import type { QueryInput } from '../schemas.js';
import type { QueryResult } from './query.js';
import { listDataQualityIssues } from './dataQuality.js';

export interface OnboardingGate {
  key:
    | 'workspace_created'
    | 'agent_connected'
    | 'data_source_connected'
    | 'first_event_observed'
    | 'metrics_activated'
    | 'data_quality_accepted'
    | 'first_query_produced'
    | 'first_decision_saved';
  complete: boolean;
  evidence: Record<string, unknown>;
  blocker: string | null;
  next_action: string | null;
}

export interface OnboardingStatus {
  complete: boolean;
  gates: OnboardingGate[];
  next_blocker: OnboardingGate | null;
  final_result: {
    metric_key: string;
    metric_purpose: string;
    query_window: { from: string; to: string };
    source: 'native' | 'posthog';
    next_action: string;
  } | null;
}

export async function recordAgentObservation(
  pool: pg.Pool,
  projectId: string,
  env: string,
  client: string,
  actor: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO agent_observations (
       project_id, env, client, observed_by
     ) VALUES ($1, $2, $3, $4)
     ON CONFLICT (project_id, env, client) DO UPDATE SET
       observed_by = EXCLUDED.observed_by,
       observed_at = now()`,
    [projectId, env, client, actor],
  );
}

export async function recordQueryRun(
  pool: pg.Pool,
  projectId: string,
  env: string,
  query: QueryInput,
  result: QueryResult,
  actor: string,
): Promise<void> {
  const source = ('meta' in result && result.meta.source === 'posthog')
    ? 'posthog'
    : 'native';
  await pool.query(
    `INSERT INTO query_runs (
       project_id, env, source, query, result_summary, operator
     ) VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      projectId,
      env,
      source,
      JSON.stringify(query),
      JSON.stringify(summarizeResult(result)),
      actor,
    ],
  );
}

export async function acknowledgeOnboardingGate(
  pool: pg.Pool,
  projectId: string,
  env: string,
  gateKey: string,
  reason: string,
  actor: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO onboarding_acknowledgements (
       project_id, env, gate_key, reason, acknowledged_by
     ) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (project_id, env, gate_key) DO UPDATE SET
       reason = EXCLUDED.reason,
       acknowledged_by = EXCLUDED.acknowledged_by,
       acknowledged_at = now()`,
    [projectId, env, gateKey, reason, actor],
  );
}

export async function getOnboardingStatus(
  pool: pg.Pool,
  eventStore: EventStore,
  projectId: string,
  env: string,
): Promise<OnboardingStatus> {
  const [
    project,
    agent,
    source,
    event,
    metric,
    query,
    decision,
    insight,
    acknowledgement,
    quality,
  ] = await Promise.all([
    pool.query('SELECT slug, name FROM projects WHERE id = $1', [projectId]),
    pool.query(
      `SELECT client, observed_at FROM agent_observations
       WHERE project_id = $1 AND env = $2
       ORDER BY observed_at DESC LIMIT 1`,
      [projectId, env],
    ),
    pool.query(
      `SELECT
         (
           SELECT max(created_at) FROM api_keys
           WHERE project_id = $1 AND kind = 'ingest' AND env = $2
             AND revoked_at IS NULL
         ) AS native_key_created_at,
         (
           SELECT max(verified_at) FROM source_connections
           WHERE project_id = $1 AND provider = 'posthog'
             AND status = 'verified'
         ) AS posthog_verified_at`,
      [projectId, env],
    ),
    pool.query(
      `SELECT count(*)::int AS count, max("timestamp") AS last_seen
       FROM events
       WHERE project_id = $1 AND env = $2 AND is_system = false`,
      [projectId, env],
    ),
    pool.query(
      `SELECT m.key, m.purpose,
         COALESCE(m.source->>'data_source', 'native') AS source
       FROM metrics m
       WHERE m.project_id = $1 AND m.status = 'active'
         AND (
           (
             COALESCE(m.source->>'data_source', 'native') = 'native'
             AND EXISTS (
               SELECT 1 FROM events e
               WHERE e.project_id = $1 AND e.env = $2
                 AND e.event = m.source->>'event'
                 AND e.registered = true
             )
           )
           OR
           (
             m.source->>'data_source' = 'posthog'
             AND EXISTS (
               SELECT 1 FROM source_connections sc
               WHERE sc.project_id = $1
                 AND sc.id = (m.source->>'source_connection_id')::uuid
                 AND sc.status = 'verified'
             )
           )
         )
       ORDER BY m.updated_at DESC LIMIT 1`,
      [projectId, env],
    ),
    pool.query(
      `SELECT id, source, query, result_summary, created_at
       FROM query_runs
       WHERE project_id = $1 AND env = $2
       ORDER BY created_at DESC, id DESC LIMIT 1`,
      [projectId, env],
    ),
    pool.query(
      `SELECT d.id, d.status, d.proposed_outcome, d.proposed_rationale,
              d.accepted_outcome, d.accepted_rationale,
              e.source, e.observed_window, e.primary_evidence, d.created_at
       FROM decisions d
       JOIN evidence_sets e ON e.id = d.evidence_id
       JOIN releases r ON r.id = d.release_id
       WHERE d.project_id = $1 AND r.env = $2
       ORDER BY d.created_at DESC, d.id DESC LIMIT 1`,
      [projectId, env],
    ),
    pool.query(
      `SELECT i.id, i.title, i.body, i.query, i.created_at,
              q.id AS query_run_id, q.source AS query_source,
              q.result_summary AS query_result_summary,
              q.created_at AS query_created_at
       FROM insights i
       JOIN LATERAL (
         SELECT id, source, result_summary, created_at
         FROM query_runs
         WHERE project_id = $1 AND env = $2
           AND query->>'kind' = i.query->>'kind'
           AND (
             (query->>'kind' = 'funnel'
               AND COALESCE(query->>'funnel', '') = COALESCE(i.query->>'funnel', '')
               AND COALESCE(query->'steps', '[]'::jsonb) = COALESCE(i.query->'steps', '[]'::jsonb))
             OR
             (query->>'kind' <> 'funnel' AND query->>'metric' = i.query->>'metric')
           )
           AND query->>'date_from' = i.query->>'date_from'
           AND COALESCE(query->>'date_to', '') = COALESCE(i.query->>'date_to', '')
           AND COALESCE(query->>'interval', 'day') = COALESCE(i.query->>'interval', 'day')
           AND COALESCE(query->>'env', 'prod') = COALESCE(i.query->>'env', 'prod')
           AND COALESCE(query->'filters', '[]'::jsonb) = COALESCE(i.query->'filters', '[]'::jsonb)
           AND COALESCE(query->'breakdown', 'null'::jsonb) = COALESCE(i.query->'breakdown', 'null'::jsonb)
           AND created_at <= i.created_at
         ORDER BY created_at DESC, id DESC
         LIMIT 1
       ) q ON true
       WHERE i.project_id = $1 AND i.query IS NOT NULL
       ORDER BY i.created_at DESC, i.id DESC LIMIT 1`,
      [projectId, env],
    ),
    pool.query(
      `SELECT reason, acknowledged_by, acknowledged_at
       FROM onboarding_acknowledgements
       WHERE project_id = $1 AND env = $2
         AND gate_key = 'data_quality_accepted'`,
      [projectId, env],
    ),
    listDataQualityIssues(pool, eventStore, projectId, env),
  ]);

  const projectRow = project.rows[0];
  const sourceRow = source.rows[0] ?? { native_key_created_at: null, posthog_verified_at: null };
  const nativeSource = Boolean(sourceRow.native_key_created_at);
  const posthogSource = Boolean(sourceRow.posthog_verified_at);
  const eventRow = event.rows[0] ?? { count: 0, last_seen: null };
  const metricRow = metric.rows[0];
  const queryRow = query.rows[0];
  const decisionRow = decision.rows[0];
  const insightRow = insight.rows[0];
  const qualityAccepted = quality.issues.length === 0 || Boolean(acknowledgement.rows[0]);

  const gates: OnboardingGate[] = [
    gate(
      'workspace_created',
      Boolean(projectRow),
      projectRow ? { project: projectRow.slug } : {},
      'The workspace project does not exist.',
      'Create a project before connecting measurement.',
    ),
    gate(
      'agent_connected',
      Boolean(agent.rows[0]),
      agent.rows[0] ?? {},
      'No MCP-marked onboarding request has reached this project.',
      'Call get_onboarding_status through the configured MCP client.',
    ),
    gate(
      'data_source_connected',
      nativeSource || posthogSource,
      {
        native: nativeSource,
        posthog: posthogSource,
        native_key_created_at: sourceRow.native_key_created_at ?? null,
        posthog_verified_at: sourceRow.posthog_verified_at ?? null,
      },
      'No native ingest key or verified PostHog source is connected.',
      'Issue a pk_ ingest key or configure and verify PostHog.',
    ),
    gate(
      'first_event_observed',
      Number(eventRow.count) > 0 || Boolean(queryRow?.source === 'posthog'),
      {
        observation_source: Number(eventRow.count) > 0
          ? 'native'
          : queryRow?.source === 'posthog'
            ? 'posthog'
            : null,
        native_events: Number(eventRow.count),
        last_seen: eventRow.last_seen ?? null,
        posthog_query_at: queryRow?.source === 'posthog' ? queryRow.created_at : null,
      },
      'No real product observation has reached Poolstatis.',
      'Send a native event or run a verified PostHog query.',
    ),
    gate(
      'metrics_activated',
      Boolean(metricRow),
      metricRow ? { metric_key: metricRow.key, source: metricRow.source } : {},
      'No active metric has verified source evidence.',
      'Review and activate a metric, then observe its real source event.',
    ),
    gate(
      'data_quality_accepted',
      qualityAccepted,
      {
        issues: quality.issues.length,
        ...(acknowledgement.rows[0]
          ? { acknowledgement: acknowledgement.rows[0] }
          : {}),
      },
      'Data-quality issues remain unacknowledged.',
      'Fix the listed evidence issues or explicitly acknowledge the risk.',
    ),
    gate(
      'first_query_produced',
      Boolean(queryRow),
      queryRow
        ? { query_run_id: queryRow.id, source: queryRow.source, created_at: queryRow.created_at }
        : {},
      'No typed query has produced a real result.',
      'Run a trend or funnel against an active metric.',
    ),
    gate(
      'first_decision_saved',
      Boolean(decisionRow || insightRow),
      decisionRow
        ? {
            decision_id: decisionRow.id,
            status: decisionRow.status,
            outcome: decisionRow.accepted_outcome ?? decisionRow.proposed_outcome,
            created_at: decisionRow.created_at,
          }
        : insightRow
          ? { insight_id: insightRow.id, title: insightRow.title, created_at: insightRow.created_at }
        : {},
      'No evidence-backed insight or decision has been saved.',
      'Save the real query result with one next action.',
    ),
  ];

  const finalResult = await finalResultFor(pool, projectId, insightRow, decisionRow);
  return {
    complete: gates.every((item) => item.complete),
    gates,
    next_blocker: gates.find((item) => !item.complete) ?? null,
    final_result: finalResult,
  };
}

function gate(
  key: OnboardingGate['key'],
  complete: boolean,
  evidence: Record<string, unknown>,
  blocker: string,
  nextAction: string,
): OnboardingGate {
  return {
    key,
    complete,
    evidence,
    blocker: complete ? null : blocker,
    next_action: complete ? null : nextAction,
  };
}

function summarizeResult(result: QueryResult): Record<string, unknown> {
  const meta = result.meta;
  if (result.kind === 'trend') {
    return {
      kind: result.kind,
      points: result.series.length,
      total: result.series.reduce((sum, point) => sum + point.value, 0),
      query_window: meta.date_range ?? null,
    };
  }
  if (result.kind === 'funnel') {
    return {
      kind: result.kind,
      steps: result.steps.map((step) => ({
        metric_key: step.metric_key,
        actors: step.actors,
      })),
      query_window: meta.date_range ?? null,
    };
  }
  return { kind: result.kind, query_window: meta.date_range ?? null };
}

async function finalResultFor(
  pool: pg.Pool,
  projectId: string,
  insightRow: Record<string, any> | undefined,
  decisionRow: Record<string, any> | undefined,
): Promise<OnboardingStatus['final_result']> {
  if (decisionRow) {
    const metric = decisionRow.primary_evidence?.metric;
    const window = decisionRow.observed_window;
    if (metric?.key && metric?.purpose && window?.from && window?.to) {
      return {
        metric_key: metric.key,
        metric_purpose: metric.purpose,
        query_window: { from: window.from, to: window.to },
        source: decisionRow.source,
        next_action: decisionRow.accepted_rationale ?? decisionRow.proposed_rationale,
      };
    }
  }
  if (!insightRow) return null;
  const funnelSteps = Array.isArray(insightRow.query_result_summary?.steps)
    ? insightRow.query_result_summary.steps
    : [];
  const terminalFunnelMetric = funnelSteps.length > 0
    && typeof funnelSteps[funnelSteps.length - 1]?.metric_key === 'string'
    ? funnelSteps[funnelSteps.length - 1].metric_key
    : null;
  const metricKey = typeof insightRow.query?.metric === 'string'
    ? insightRow.query.metric
    : terminalFunnelMetric;
  const window = insightRow.query_result_summary?.query_window;
  if (!metricKey || !window?.from || !window?.to) return null;
  const metric = await pool.query<{ purpose: string }>(
    'SELECT purpose FROM metrics WHERE project_id = $1 AND key = $2',
    [projectId, metricKey],
  );
  if (!metric.rows[0]) return null;
  return {
    metric_key: metricKey,
    metric_purpose: metric.rows[0].purpose,
    query_window: { from: window.from, to: window.to },
    source: insightRow.query_source,
    next_action: insightRow.body,
  };
}
