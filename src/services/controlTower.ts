import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import type { FunnelQueryInput, TrendQueryInput } from '../schemas.js';
import type { EventStore } from '../stores/eventStore.js';
import { getProjectIntent } from './projectIntents.js';
import type { QueryService } from './query.js';
import { listFunnels, type Funnel, type Metric } from './registry.js';
import { listDataQualityIssues } from './dataQuality.js';
import { listDecisions } from './decisions.js';
import { getOnboardingStatus } from './onboarding.js';
import {
  summarizeIngestWarningOccurrences,
  type IngestWarningWindowSummary,
  type WarningKind,
} from './warnings.js';

export const controlTowerStateSchema = z.enum([
  'ready', 'partial', 'empty', 'unavailable', 'not_configured', 'stale', 'error',
]);
export const trustStateSchema = z.enum(['trusted', 'partial', 'blocked', 'unavailable']);
export const attentionSeveritySchema = z.enum(['critical', 'high', 'medium', 'low', 'info']);

export const controlTowerScopeSchema = z.object({
  organization_id: z.string().optional(),
  project_slug: z.string().optional(),
  environment: z.string().optional(),
  window: z.object({
    from: z.string().datetime(),
    to: z.string().datetime(),
    timezone: z.literal('UTC'),
  }).strict(),
  comparison: z.object({
    from: z.string().datetime(),
    to: z.string().datetime(),
    basis: z.enum(['previous_period', 'previous_cycle', 'none']),
  }).strict().optional(),
}).strict();

export const answerBlockSchema = z.object({
  state: controlTowerStateSchema,
  headline: z.string(),
  takeaway: z.string(),
  primary_value: z.object({
    value: z.union([z.number(), z.string(), z.null()]),
    unit: z.enum(['count', 'percent', 'percentage_point', 'duration_ms', 'date', 'text']),
    formatted: z.string(),
  }).strict().optional(),
  delta: z.object({
    value: z.number().nullable(),
    unit: z.enum(['count', 'percent', 'percentage_point']),
    direction: z.enum(['up', 'down', 'flat', 'unknown']),
    comparison_label: z.string(),
  }).strict().optional(),
  why_it_matters: z.string(),
}).strict();

export const evidenceBlockSchema = z.object({
  state: trustStateSchema,
  as_of: z.string().datetime(),
  freshness: z.enum(['fresh', 'stale', 'unknown']),
  source_refs: z.array(z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('metric'), key: z.string(), purpose: z.string() }).strict(),
    z.object({ kind: z.literal('funnel'), key: z.string(), goal: z.string() }).strict(),
    z.object({ kind: z.literal('release'), id: z.string() }).strict(),
    z.object({ kind: z.literal('experiment'), key: z.string() }).strict(),
    z.object({ kind: z.literal('usage_ledger'), meter: z.literal('events_stored') }).strict(),
    z.object({ kind: z.literal('operator_rule'), rule_id: z.string(), rule_version: z.number().int() }).strict(),
  ])),
  aggregation: z.string().optional(),
  denominator: z.object({ label: z.string(), value: z.number().nullable() }).strict().optional(),
  sample: z.object({
    eligible: z.number().nullable(),
    observed: z.number().nullable(),
    coverage: z.number().nullable(),
  }).strict().optional(),
  warnings: z.array(z.object({
    code: z.string(),
    message: z.string(),
    remediation_action_id: z.string().optional(),
  }).strict()),
  unavailable_reasons: z.array(z.object({
    code: z.string(),
    message: z.string(),
    prerequisite_action_id: z.string().optional(),
  }).strict()),
  reproducible_query: z.record(z.unknown()).optional(),
}).strict();

export const controlTowerActionSchema = z.discriminatedUnion('kind', [
  z.object({ id: z.string(), kind: z.literal('navigate'), label: z.string(), href: z.string() }).strict(),
  z.object({ id: z.string(), kind: z.literal('run_typed_query'), label: z.string(), query: z.record(z.unknown()) }).strict(),
  z.object({ id: z.string(), kind: z.literal('copy_agent_task'), label: z.string(), task: z.string() }).strict(),
  z.object({ id: z.string(), kind: z.literal('open_confirmation'), label: z.string(), mutation: z.string(), impact: z.string() }).strict(),
  z.object({ id: z.string(), kind: z.literal('retry'), label: z.string() }).strict(),
]);

export const attentionItemSchema = z.object({
  id: z.string(),
  rule_id: z.string(),
  rule_version: z.number().int(),
  severity: attentionSeveritySchema,
  state: z.enum(['open', 'acknowledged', 'resolved', 'unavailable']),
  title: z.string(),
  reason: z.string(),
  impact: z.string(),
  affected: z.array(z.object({
    kind: z.enum(['answer', 'metric', 'funnel', 'project', 'customer']),
    ref: z.string(),
  }).strict()),
  evidence: evidenceBlockSchema,
  delta: answerBlockSchema.shape.delta,
  priority: z.object({
    blocking_now: z.boolean(),
    forecasted_at: z.string().datetime().nullable(),
  }).strict().optional(),
  primary_action: controlTowerActionSchema,
}).strict();

export const controlTowerResultSchema = z.object({
  schema_version: z.literal(1),
  request_id: z.string(),
  generated_at: z.string().datetime(),
  home_funnel_key: z.string().nullable().optional(),
  scope: controlTowerScopeSchema,
  answer: answerBlockSchema,
  attention: z.array(attentionItemSchema),
  evidence: evidenceBlockSchema,
  primary_action: controlTowerActionSchema,
  secondary_actions: z.array(controlTowerActionSchema),
}).strict();

export type ControlTowerState = z.infer<typeof controlTowerStateSchema>;
export type TrustState = z.infer<typeof trustStateSchema>;
export type AttentionSeverity = z.infer<typeof attentionSeveritySchema>;
export type ControlTowerScope = z.infer<typeof controlTowerScopeSchema>;
export type AnswerBlock = z.infer<typeof answerBlockSchema>;
export type EvidenceBlock = z.infer<typeof evidenceBlockSchema>;
export type ControlTowerAction = z.infer<typeof controlTowerActionSchema>;
export type AttentionItem = z.infer<typeof attentionItemSchema>;
export type ControlTowerResult = z.infer<typeof controlTowerResultSchema>;

function selectHomeFunnel(funnels: Funnel[], primaryGoal: string | null): Funnel | null {
  const ordered = [...funnels].sort((left, right) => left.key.localeCompare(right.key));
  if (!primaryGoal) return ordered[0] ?? null;
  const exact = ordered.find((funnel) => funnel.key === primaryGoal);
  if (exact) return exact;
  const tokens = primaryGoal.split('_').filter((token) => token.length > 3);
  const ranked = ordered
    .map((funnel) => {
      const haystack = [
        funnel.key,
        funnel.name,
        funnel.goal,
        ...funnel.steps.flatMap((step) => [step.metric_key, step.label]),
      ].join(' ').toLowerCase();
      return { funnel, score: tokens.filter((token) => haystack.includes(token)).length };
    })
    .sort((left, right) => right.score - left.score || left.funnel.key.localeCompare(right.funnel.key));
  return ranked[0]?.score ? ranked[0].funnel : ordered[0] ?? null;
}

async function funnelAttention(
  pool: pg.Pool,
  queryService: QueryService,
  project: { id: string; slug: string },
  env: string,
  from: Date,
  now: Date,
): Promise<{ funnelKey: string | null; item: AttentionItem | null }> {
  const [funnels, intent] = await Promise.all([
    listFunnels(pool, project.id),
    getProjectIntent(pool, project.id),
  ]);
  const funnel = selectHomeFunnel(funnels, intent?.primary_goal_id ?? null);
  if (!funnel) return { funnelKey: null, item: null };
  const href = `/analyze/funnels?funnel=${encodeURIComponent(funnel.key)}&env=${encodeURIComponent(env)}`;
  try {
    const result = await queryService.run(project.id, {
      kind: 'funnel',
      funnel: funnel.key,
      date_from: from.toISOString(),
      date_to: now.toISOString(),
      env,
    }, now);
    if (result.kind !== 'funnel') return { funnelKey: funnel.key, item: null };
    const loss = result.summary.biggest_absolute_loss;
    if (!loss || loss.lost_actors <= 0) return { funnelKey: funnel.key, item: null };
    const fromStep = result.steps[loss.from_step];
    const toStep = result.steps[loss.to_step];
    if (!fromStep || !toStep) return { funnelKey: funnel.key, item: null };
    const rate = loss.drop_rate === null
      ? 'rate unavailable'
      : `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(loss.drop_rate * 100)}%`;
    const actionHref = `${href}&from_step=${loss.from_step}&to_step=${loss.to_step}`;
    const delta = result.summary.delta_percentage_points;
    return {
      funnelKey: funnel.key,
      item: {
        id: `funnel.biggest_loss.${funnel.key}`,
        rule_id: 'funnel.biggest_loss',
        rule_version: 1,
        severity: 'info',
        state: 'open',
        title: `Biggest loss: ${fromStep.label} -> ${toStep.label}`,
        reason: `${loss.lost_actors} actors were lost at this step (${rate}).`,
        impact: funnel.goal,
        affected: [{ kind: 'funnel', ref: funnel.key }],
        evidence: result.evidence,
        ...(delta === null ? {} : {
          delta: {
            value: delta,
            unit: 'percentage_point' as const,
            direction: delta > 0 ? 'up' as const : delta < 0 ? 'down' as const : 'flat' as const,
            comparison_label: 'previous exact period',
          },
        }),
        primary_action: {
          id: `investigate_funnel_step.${funnel.key}.${loss.from_step}.${loss.to_step}`,
          kind: 'navigate',
          label: `Investigate ${fromStep.label} -> ${toStep.label}`,
          href: actionHref,
        },
      },
    };
  } catch {
    return {
      funnelKey: funnel.key,
      item: {
        id: `funnel.biggest_loss.${funnel.key}`,
        rule_id: 'funnel.biggest_loss',
        rule_version: 1,
        severity: 'low',
        state: 'unavailable',
        title: 'Funnel loss is unavailable',
        reason: 'The registered funnel could not be evaluated for the selected project, environment and window.',
        impact: funnel.goal,
        affected: [{ kind: 'funnel', ref: funnel.key }],
        evidence: {
          state: 'unavailable',
          as_of: now.toISOString(),
          freshness: 'unknown',
          source_refs: [{ kind: 'funnel', key: funnel.key, goal: funnel.goal }],
          warnings: [],
          unavailable_reasons: [{
            code: 'funnel_query_unavailable',
            message: 'The typed saved-funnel query did not produce a result.',
            prerequisite_action_id: `investigate_funnel_step.${funnel.key}`,
          }],
        },
        primary_action: {
          id: `investigate_funnel_step.${funnel.key}`,
          kind: 'navigate',
          label: 'Review funnel evidence',
          href,
        },
      },
    };
  }
}

export const funnelLossSchema = z.object({
  from_step: z.number().int().nonnegative(),
  to_step: z.number().int().nonnegative(),
  lost_actors: z.number().nonnegative(),
  drop_rate: z.number().nullable(),
}).strict();

export const funnelSummarySchema = z.object({
  overall_conversion: z.number().nullable(),
  previous_overall_conversion: z.number().nullable(),
  delta_percentage_points: z.number().nullable(),
  biggest_absolute_loss: funnelLossSchema.nullable(),
  biggest_percentage_loss: funnelLossSchema.nullable(),
}).strict();

export type FunnelLoss = z.infer<typeof funnelLossSchema>;
export type FunnelSummary = z.infer<typeof funnelSummarySchema>;

const severityOrder: Record<AttentionSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

const freshnessOrder: Record<EvidenceBlock['freshness'], number> = {
  fresh: 0,
  stale: 1,
  unknown: 2,
};

/**
 * Server-owned semantic priority. Optional priority metadata keeps the
 * response additive for existing clients while making forecast ordering
 * explicit for current and future rule composers.
 */
export function orderAttentionItems(items: AttentionItem[]): AttentionItem[] {
  return [...items].sort((left, right) => {
    const leftBlocking = left.priority?.blocking_now ?? left.evidence.state === 'blocked';
    const rightBlocking = right.priority?.blocking_now ?? right.evidence.state === 'blocked';
    if (leftBlocking !== rightBlocking) return leftBlocking ? -1 : 1;

    const leftForecast = left.priority?.forecasted_at
      ? Date.parse(left.priority.forecasted_at)
      : Number.POSITIVE_INFINITY;
    const rightForecast = right.priority?.forecasted_at
      ? Date.parse(right.priority.forecasted_at)
      : Number.POSITIVE_INFINITY;
    if (leftForecast !== rightForecast) return leftForecast - rightForecast;

    const severity = severityOrder[left.severity] - severityOrder[right.severity];
    if (severity !== 0) return severity;

    const affected = right.affected.length - left.affected.length;
    if (affected !== 0) return affected;

    const freshness = freshnessOrder[left.evidence.freshness] - freshnessOrder[right.evidence.freshness];
    if (freshness !== 0) return freshness;

    return left.rule_id.localeCompare(right.rule_id) || left.id.localeCompare(right.id);
  });
}

function operationalEvidence(
  now: Date,
  state: TrustState,
  rule: string,
  aggregation: string,
  sample?: EvidenceBlock['sample'],
): EvidenceBlock {
  return evidenceBlockSchema.parse({
    state,
    as_of: now.toISOString(),
    freshness: 'fresh',
    source_refs: [{ kind: 'operator_rule', rule_id: rule, rule_version: 1 }],
    aggregation,
    ...(sample ? { sample } : {}),
    warnings: [],
    unavailable_reasons: [],
  });
}

function warningAttention(
  projectSlug: string,
  env: string,
  kind: WarningKind,
  summaries: IngestWarningWindowSummary[],
  now: Date,
): AttentionItem | null {
  const summary = summaries.find((warning) => warning.kind === kind);
  if (!summary) return null;
  const observations = summary.count;
  const severity: AttentionSeverity = kind === 'rejected' ? 'high' : kind === 'unregistered' ? 'medium' : 'low';
  const title = kind === 'rejected'
    ? 'Accepted-event coverage is losing rejected observations'
    : kind === 'unregistered'
      ? 'Unregistered events need a measurement decision'
      : 'Clock skew reduces time-window trust';
  const impact = kind === 'rejected'
    ? 'Rejected observations are absent from product answers.'
    : kind === 'unregistered'
      ? 'Unregistered events are retained but cannot back trusted registry metrics until reviewed.'
      : 'Skewed timestamps can move observations into the wrong analysis window.';
  const action: ControlTowerAction = {
    id: `review_ingest_${kind}`,
    kind: 'navigate',
    label: 'Review ingest warnings',
    href: `/data?tab=warnings&env=${encodeURIComponent(env)}&warning=${kind}`,
  };
  return attentionItemSchema.parse({
    id: `ingest.${kind}`,
    rule_id: `ingest.${kind}`,
    rule_version: 1,
    severity,
    state: 'open',
    title,
    reason: `${observations} observations across ${summary.event_count} event names are recorded in this warning class.`,
    impact,
    affected: [{ kind: 'project', ref: `${projectSlug}:${env}` }],
    evidence: operationalEvidence(
      now,
      kind === 'rejected' ? 'blocked' : 'partial',
      `ingest.${kind}`,
      'ingest warning occurrences in the selected control-tower window by warning class and event name; raw samples are excluded',
      { eligible: null, observed: observations, coverage: null },
    ),
    priority: { blocking_now: kind === 'rejected', forecasted_at: null },
    primary_action: action,
  });
}

export async function getProjectControlTower(
  pool: pg.Pool,
  eventStore: EventStore,
  queryService: QueryService,
  project: { id: string; slug: string },
  env: string,
  rangeDays: 7 | 30 | 90,
  now = new Date(),
): Promise<ControlTowerResult> {
  const from = new Date(now.getTime() - rangeDays * 86_400_000);
  const [onboarding, warnings, quality, decisions, homeFunnel] = await Promise.all([
    getOnboardingStatus(pool, eventStore, project.id, env),
    summarizeIngestWarningOccurrences(pool, project.id, { env, from, to: now }),
    listDataQualityIssues(pool, eventStore, project.id, env, { sinceDays: rangeDays }),
    listDecisions(pool, project.id, { status: 'proposed', env }),
    funnelAttention(pool, queryService, project, env, from, now),
  ]);
  const funnelItem = homeFunnel.item;
  const attention: AttentionItem[] = [];
  for (const kind of ['rejected', 'unregistered', 'clock_skew'] as const) {
    const item = warningAttention(project.slug, env, kind, warnings, now);
    if (item) attention.push(item);
  }
  if (quality.issues.length > 0) {
    attention.push({
      id: 'data_quality.entity_status',
      rule_id: 'data_quality.entity_status',
      rule_version: 1,
      severity: 'high',
      state: 'open',
      title: 'Entity state conflicts with observed terminal events',
      reason: `${quality.issues.length} conflicts were found in the selected evidence window.`,
      impact: 'State-based answers may disagree with immutable event evidence.',
      affected: [{ kind: 'project', ref: `${project.slug}:${env}` }],
      evidence: operationalEvidence(
        now,
        'blocked',
        'data_quality.entity_status',
        'registered terminal-event specifications compared with current entity state',
        { eligible: quality.checked.evidence_rows, observed: quality.issues.length, coverage: null },
      ),
      priority: { blocking_now: true, forecasted_at: null },
      primary_action: { id: 'review_data_quality', kind: 'navigate', label: 'Review data quality', href: `/data?tab=health&env=${encodeURIComponent(env)}&quality=conflict` },
    });
  }
  if (decisions.length > 0) {
    attention.push({
      id: 'decision.awaiting_approval',
      rule_id: 'decision.awaiting_approval',
      rule_version: 1,
      severity: 'medium',
      state: 'open',
      title: 'Evidence-backed decisions await human review',
      reason: `${decisions.length} proposed decisions are unresolved for this environment.`,
      impact: 'No product change is applied until a human approves, edits or rejects the proposal.',
      affected: [{ kind: 'project', ref: `${project.slug}:${env}` }],
      evidence: {
        ...operationalEvidence(now, 'trusted', 'decision.awaiting_approval', 'proposed decisions joined to release environment', { eligible: decisions.length, observed: decisions.length, coverage: 1 }),
        source_refs: decisions.map((decision) => ({ kind: 'release' as const, id: decision.release_id })),
      },
      priority: { blocking_now: false, forecasted_at: null },
      primary_action: { id: 'review_decisions', kind: 'navigate', label: 'Review decisions', href: '/changes' },
    });
  }
  if (onboarding.next_blocker && onboarding.next_blocker.key !== 'data_quality_accepted') {
    const blocker = onboarding.next_blocker;
    attention.push({
      id: `onboarding.${blocker.key}`,
      rule_id: `onboarding.${blocker.key}`,
      rule_version: 1,
      severity: 'low',
      state: 'open',
      title: 'Measurement setup is incomplete',
      reason: blocker.blocker ?? 'A required onboarding gate is incomplete.',
      impact: 'A trusted product answer remains unavailable until the required evidence exists.',
      affected: [{ kind: 'project', ref: `${project.slug}:${env}` }],
      evidence: operationalEvidence(now, 'partial', `onboarding.${blocker.key}`, 'required onboarding gates', { eligible: 1, observed: 0, coverage: 0 }),
      priority: { blocking_now: true, forecasted_at: null },
      primary_action: { id: 'continue_setup', kind: 'navigate', label: 'Continue setup', href: `/setup?env=${encodeURIComponent(env)}` },
    });
  }
  if (funnelItem) attention.push(funnelItem);
  const orderedAttention = orderAttentionItems(attention);
  const primaryAction = orderedAttention[0]?.primary_action
    ?? { id: 'review_measurement_evidence', kind: 'navigate' as const, label: 'Review measurement evidence', href: `/setup?env=${encodeURIComponent(env)}` };
  const blocking = orderedAttention.some((item) => item.priority?.blocking_now ?? item.evidence.state === 'blocked');
  const evidenceState: TrustState = blocking ? 'blocked' : orderedAttention.length > 0 ? 'partial' : 'trusted';
  const answerState: ControlTowerState = orderedAttention.length > 0 ? 'partial' : onboarding.complete ? 'ready' : 'empty';
  const top = orderedAttention[0];
  return controlTowerResultSchema.parse({
    schema_version: 1,
    request_id: randomUUID(),
    generated_at: now.toISOString(),
    home_funnel_key: homeFunnel.funnelKey,
    scope: {
      project_slug: project.slug,
      environment: env,
      window: { from: from.toISOString(), to: now.toISOString(), timezone: 'UTC' },
    },
    answer: {
      state: answerState,
      headline: orderedAttention.length > 0
        ? `${orderedAttention.length} items need attention`
        : 'No evaluated setup or data-quality blockers found',
      takeaway: top?.reason ?? 'The evaluated onboarding, ingest, data-quality and decision rules have no open items.',
      primary_value: { value: orderedAttention.length, unit: 'count', formatted: String(orderedAttention.length) },
      why_it_matters: top?.impact ?? 'Visible evaluated guardrails let a human verify trust before acting.',
    },
    attention: orderedAttention,
    evidence: {
      state: evidenceState,
      as_of: now.toISOString(),
      freshness: 'fresh',
      source_refs: [
        { kind: 'operator_rule', rule_id: 'onboarding.gates', rule_version: 1 },
        { kind: 'operator_rule', rule_id: 'ingest.warnings', rule_version: 1 },
        { kind: 'operator_rule', rule_id: 'data_quality.entity_status', rule_version: 1 },
        { kind: 'operator_rule', rule_id: 'decision.awaiting_approval', rule_version: 1 },
        ...(funnelItem ? funnelItem.evidence.source_refs : []),
      ],
      aggregation: `server-owned rule evaluation over the last ${rangeDays} days`,
      warnings: orderedAttention.filter((item) => item.severity === 'low').map((item) => ({
        code: item.rule_id,
        message: item.reason,
        remediation_action_id: item.primary_action.id,
      })),
      unavailable_reasons: [],
    },
    primary_action: primaryAction,
    secondary_actions: orderedAttention.slice(1, 3).map((item) => item.primary_action),
  });
}

function formatted(value: number): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value);
}

export function trendControlBlocks(
  metric: Metric,
  query: TrendQueryInput,
  series: Array<{ bucket?: string; value: number }>,
  now: Date,
  source: 'native' | 'posthog',
): { answer: AnswerBlock; evidence: EvidenceBlock } {
  const sourceDefinition = metric.source as { agg?: 'sum' | 'avg' | 'min' | 'max' | 'p90' };
  const additive = metric.type === 'count'
    || (metric.type === 'value' && (sourceDefinition.agg ?? 'sum') === 'sum');
  const latestPoint = series.reduce<(typeof series)[number] | null>((latest, point) => {
    if (!latest) return point;
    if (!point.bucket || !latest.bucket) return point;
    return point.bucket >= latest.bucket ? point : latest;
  }, null);
  const latestValue = latestPoint?.value ?? 0;
  const value = additive
    ? series.reduce((sum, point) => sum + point.value, 0)
    : latestValue;
  const observedBuckets = new Set(series.map((point, index) => point.bucket ?? `row:${index}`)).size;
  const earlierBuckets = Math.max(0, observedBuckets - 1);
  const hasWindowObservations = series.length > 0;
  const unit: NonNullable<AnswerBlock['primary_value']>['unit'] = metric.type === 'count'
    || metric.type === 'unique_actors' || metric.type === 'state'
    ? 'count'
    : 'text';
  const aggregation = metric.type === 'unique_actors'
    ? 'latest returned bucket unique actors; bucket counts are not summed because actors can repeat'
    : metric.type === 'count'
      ? 'count of accepted events'
      : additive
        ? 'sum of registered value-metric buckets'
        : `latest returned bucket for registered ${sourceDefinition.agg ?? 'sum'} value aggregation`;
  return {
    answer: {
      state: hasWindowObservations ? 'ready' : 'empty',
      headline: !hasWindowObservations
        ? `No ${metric.name} observations in this window`
        : metric.type === 'unique_actors'
          ? `${metric.name} latest bucket: ${formatted(value)}`
          : `${metric.name}: ${formatted(value)}`,
      takeaway: metric.type === 'unique_actors'
        ? latestValue === 0 && observedBuckets > 0
          ? `0 unique actors matched the latest returned bucket; ${earlierBuckets} earlier ${earlierBuckets === 1 ? 'bucket has' : 'buckets have'} observations in the selected window.`
          : `${formatted(latestValue)} unique actors matched the latest returned bucket; the full series remains available for trend interpretation.`
        : additive
        ? `${formatted(value)} matched the registered metric in the selected window.`
        : `${formatted(value)} is the latest returned bucket value; the full series remains available for trend interpretation.`,
      primary_value: { value, unit, formatted: formatted(value) },
      why_it_matters: metric.purpose,
    },
    evidence: {
      state: 'trusted',
      as_of: now.toISOString(),
      freshness: 'fresh',
      source_refs: [{ kind: 'metric', key: metric.key, purpose: metric.purpose }],
      aggregation,
      sample: metric.type === 'count'
        ? { eligible: null, observed: value, coverage: null }
        : {
            eligible: observedBuckets,
            observed: observedBuckets,
            coverage: observedBuckets > 0 ? 1 : null,
          },
      warnings: source === 'posthog'
        ? [{ code: 'external_source', message: 'Computed from the configured PostHog source.' }]
        : [],
      unavailable_reasons: [],
      reproducible_query: query,
    },
  };
}

export function funnelControlBlocks(
  query: FunnelQueryInput,
  steps: Array<{ label: string; metric_key: string; purpose: string; actors: number }>,
  now: Date,
  source: 'native' | 'posthog',
  goal?: string,
  previousSteps?: Array<{ label: string; metric_key: string; purpose: string; actors: number }>,
): { summary: FunnelSummary; answer: AnswerBlock; evidence: EvidenceBlock } {
  const first = steps[0]?.actors ?? 0;
  const last = steps.at(-1)?.actors ?? 0;
  const losses: FunnelLoss[] = [];
  for (let index = 1; index < steps.length; index += 1) {
    const previous = steps[index - 1]!;
    const current = steps[index]!;
    losses.push({
      from_step: index - 1,
      to_step: index,
      lost_actors: Math.max(0, previous.actors - current.actors),
      drop_rate: previous.actors > 0
        ? Math.max(0, previous.actors - current.actors) / previous.actors
        : null,
    });
  }
  const biggestAbsolute = losses.reduce<FunnelLoss | null>((best, loss) =>
    !best || loss.lost_actors > best.lost_actors ? loss : best, null);
  const biggestPercentage = losses.reduce<FunnelLoss | null>((best, loss) => {
    if (loss.drop_rate === null) return best;
    return !best || best.drop_rate === null || loss.drop_rate > best.drop_rate ? loss : best;
  }, null);
  const overall = first > 0 ? last / first : null;
  const previousFirst = previousSteps?.[0]?.actors ?? 0;
  const previousLast = previousSteps?.at(-1)?.actors ?? 0;
  const previousOverall = previousSteps && previousFirst > 0 ? previousLast / previousFirst : null;
  const deltaPercentagePoints = overall === null || previousOverall === null
    ? null
    : Number(((overall - previousOverall) * 100).toFixed(6));
  const terminal = steps.at(-1)?.label ?? 'the final step';
  const absoluteTies = biggestAbsolute && biggestAbsolute.lost_actors > 0
    ? losses.filter((loss) => loss.lost_actors === biggestAbsolute.lost_actors)
    : [];
  const percentageTies = biggestPercentage?.drop_rate !== null && biggestPercentage?.drop_rate !== undefined
    ? losses.filter((loss) => loss.drop_rate === biggestPercentage.drop_rate)
    : [];
  const tieWarnings: EvidenceBlock['warnings'] = [];
  if (absoluteTies.length > 1 && biggestAbsolute) {
    tieWarnings.push({
      code: 'equal_biggest_absolute_loss',
      message: `Equal absolute losses were measured at ${absoluteTies.map((loss) => `${steps[loss.from_step]!.label} -> ${steps[loss.to_step]!.label}`).join(' and ')}; stable funnel step order selected ${steps[biggestAbsolute.from_step]!.label} -> ${steps[biggestAbsolute.to_step]!.label}.`,
    });
  }
  if (percentageTies.length > 1 && biggestPercentage) {
    tieWarnings.push({
      code: 'equal_biggest_percentage_loss',
      message: `Equal percentage losses were measured at ${percentageTies.map((loss) => `${steps[loss.from_step]!.label} -> ${steps[loss.to_step]!.label}`).join(' and ')}; stable funnel step order selected ${steps[biggestPercentage.from_step]!.label} -> ${steps[biggestPercentage.to_step]!.label}.`,
    });
  }
  return {
    summary: funnelSummarySchema.parse({
      overall_conversion: overall,
      previous_overall_conversion: previousOverall,
      delta_percentage_points: deltaPercentagePoints,
      biggest_absolute_loss: biggestAbsolute,
      biggest_percentage_loss: biggestPercentage,
    }),
    answer: {
      state: first === 0 ? 'empty' : 'ready',
      headline: overall === null
        ? 'No actors entered this funnel'
        : `${formatted(overall * 100)}% reached ${terminal}`,
      takeaway: first === 0
        ? 'The selected window has no measured funnel denominator.'
        : `${formatted(last)} of ${formatted(first)} actors reached the final step.`,
      ...(overall === null
        ? {}
        : { primary_value: { value: overall * 100, unit: 'percent' as const, formatted: `${formatted(overall * 100)}%` } }),
      ...(deltaPercentagePoints === null ? {} : {
        delta: {
          value: deltaPercentagePoints,
          unit: 'percentage_point' as const,
          direction: deltaPercentagePoints > 0 ? 'up' as const : deltaPercentagePoints < 0 ? 'down' as const : 'flat' as const,
          comparison_label: 'previous exact period',
        },
      }),
      why_it_matters: goal ?? (query.funnel
        ? `Conversion through the registered ${query.funnel} funnel.`
        : 'Conversion through the selected registered metric steps.'),
    },
    evidence: {
      state: first === 0 ? 'partial' : 'trusted',
      as_of: now.toISOString(),
      freshness: 'fresh',
      source_refs: query.funnel
        ? [{ kind: 'funnel', key: query.funnel, goal: goal ?? `Conversion through ${query.funnel}.` }]
        : steps.map((step) => ({ kind: 'metric' as const, key: step.metric_key, purpose: step.purpose })),
      aggregation: 'ordered unique actors within the configured funnel window',
      denominator: { label: `actors who reached ${steps[0]?.metric_key ?? 'the first step'}`, value: first > 0 ? first : null },
      sample: { eligible: first > 0 ? first : null, observed: first > 0 ? last : null, coverage: overall },
      warnings: [
        ...(source === 'posthog'
          ? [{ code: 'external_source', message: 'Computed from the configured PostHog source.' }]
          : []),
        ...tieWarnings,
      ],
      unavailable_reasons: first === 0
        ? [{ code: 'missing_denominator', message: 'No actors reached the first step.' }]
        : [],
      reproducible_query: query,
    },
  };
}
