import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import type { FunnelQueryInput, TrendQueryInput } from '../schemas.js';
import type { EventStore } from '../stores/eventStore.js';
import type { Metric } from './registry.js';
import { listDataQualityIssues } from './dataQuality.js';
import { listDecisions } from './decisions.js';
import { getOnboardingStatus } from './onboarding.js';
import { listIngestWarnings, type WarningKind } from './warnings.js';

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
  primary_action: controlTowerActionSchema,
}).strict();

export const controlTowerResultSchema = z.object({
  schema_version: z.literal(1),
  request_id: z.string(),
  generated_at: z.string().datetime(),
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
  rows: Awaited<ReturnType<typeof listIngestWarnings>>,
  now: Date,
): AttentionItem | null {
  const matching = rows.filter((warning) => warning.kind === kind);
  if (matching.length === 0) return null;
  const observations = matching.reduce((sum, warning) => sum + warning.count, 0);
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
    href: `/events?env=${encodeURIComponent(env)}&warning=${kind}`,
  };
  return attentionItemSchema.parse({
    id: `ingest.${kind}`,
    rule_id: `ingest.${kind}`,
    rule_version: 1,
    severity,
    state: 'open',
    title,
    reason: `${observations} observations across ${matching.length} event names are recorded in this warning class.`,
    impact,
    affected: [{ kind: 'project', ref: `${projectSlug}:${env}` }],
    evidence: operationalEvidence(
      now,
      kind === 'rejected' ? 'blocked' : 'partial',
      `ingest.${kind}`,
      'accumulated ingest warnings by warning class and event name; raw samples are excluded',
      { eligible: null, observed: observations, coverage: null },
    ),
    primary_action: action,
  });
}

export async function getProjectControlTower(
  pool: pg.Pool,
  eventStore: EventStore,
  project: { id: string; slug: string },
  env: string,
  rangeDays: 7 | 30 | 90,
  now = new Date(),
): Promise<ControlTowerResult> {
  const from = new Date(now.getTime() - rangeDays * 86_400_000);
  const [onboarding, allWarnings, quality, decisions] = await Promise.all([
    getOnboardingStatus(pool, eventStore, project.id, env),
    listIngestWarnings(pool, project.id, { env }),
    listDataQualityIssues(pool, eventStore, project.id, env, { sinceDays: rangeDays }),
    listDecisions(pool, project.id, { status: 'proposed', env }),
  ]);
  const warnings = allWarnings.filter((warning) => Date.parse(warning.last_seen) >= from.getTime());
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
      primary_action: { id: 'review_data_quality', kind: 'navigate', label: 'Review data quality', href: `/events?env=${encodeURIComponent(env)}&quality=conflict` },
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
      primary_action: { id: 'continue_setup', kind: 'navigate', label: 'Continue setup', href: `/setup?env=${encodeURIComponent(env)}` },
    });
  }
  attention.sort((left, right) => severityOrder[left.severity] - severityOrder[right.severity]
    || left.rule_id.localeCompare(right.rule_id));
  const primaryAction = attention[0]?.primary_action
    ?? { id: 'review_measurement_evidence', kind: 'navigate' as const, label: 'Review measurement evidence', href: `/setup?env=${encodeURIComponent(env)}` };
  const blocking = attention.some((item) => item.severity === 'critical' || item.severity === 'high');
  const evidenceState: TrustState = blocking ? 'blocked' : attention.length > 0 ? 'partial' : 'trusted';
  const answerState: ControlTowerState = attention.length > 0 ? 'partial' : onboarding.complete ? 'ready' : 'empty';
  const top = attention[0];
  return controlTowerResultSchema.parse({
    schema_version: 1,
    request_id: randomUUID(),
    generated_at: now.toISOString(),
    scope: {
      project_slug: project.slug,
      environment: env,
      window: { from: from.toISOString(), to: now.toISOString(), timezone: 'UTC' },
    },
    answer: {
      state: answerState,
      headline: attention.length > 0
        ? `${attention.length} items need attention`
        : 'No evaluated setup or data-quality blockers found',
      takeaway: top?.reason ?? 'The evaluated onboarding, ingest, data-quality and decision rules have no open items.',
      primary_value: { value: attention.length, unit: 'count', formatted: String(attention.length) },
      why_it_matters: top?.impact ?? 'Visible evaluated guardrails let a human verify trust before acting.',
    },
    attention,
    evidence: {
      state: evidenceState,
      as_of: now.toISOString(),
      freshness: 'fresh',
      source_refs: [
        { kind: 'operator_rule', rule_id: 'onboarding.gates', rule_version: 1 },
        { kind: 'operator_rule', rule_id: 'ingest.warnings', rule_version: 1 },
        { kind: 'operator_rule', rule_id: 'data_quality.entity_status', rule_version: 1 },
        { kind: 'operator_rule', rule_id: 'decision.awaiting_approval', rule_version: 1 },
      ],
      aggregation: `server-owned rule evaluation over the last ${rangeDays} days`,
      warnings: attention.filter((item) => item.severity === 'low').map((item) => ({
        code: item.rule_id,
        message: item.reason,
        remediation_action_id: item.primary_action.id,
      })),
      unavailable_reasons: [],
    },
    primary_action: primaryAction,
    secondary_actions: attention.slice(1, 3).map((item) => item.primary_action),
  });
}

function formatted(value: number): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value);
}

export function trendControlBlocks(
  metric: Metric,
  query: TrendQueryInput,
  series: Array<{ value: number }>,
  now: Date,
  source: 'native' | 'posthog',
): { answer: AnswerBlock; evidence: EvidenceBlock } {
  const sourceDefinition = metric.source as { agg?: 'sum' | 'avg' | 'min' | 'max' | 'p90' };
  const additive = metric.type === 'count'
    || (metric.type === 'value' && (sourceDefinition.agg ?? 'sum') === 'sum');
  const value = additive
    ? series.reduce((sum, point) => sum + point.value, 0)
    : series.at(-1)?.value ?? 0;
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
      state: value === 0 ? 'empty' : 'ready',
      headline: value === 0
        ? `No ${metric.name} observations in this window`
        : `${metric.name}: ${formatted(value)}`,
      takeaway: additive
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
      sample: { eligible: null, observed: value, coverage: null },
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
  const terminal = steps.at(-1)?.label ?? 'the final step';
  return {
    summary: funnelSummarySchema.parse({
      overall_conversion: overall,
      previous_overall_conversion: null,
      delta_percentage_points: null,
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
      warnings: source === 'posthog'
        ? [{ code: 'external_source', message: 'Computed from the configured PostHog source.' }]
        : [],
      unavailable_reasons: first === 0
        ? [{ code: 'missing_denominator', message: 'No actors reached the first step.' }]
        : [],
      reproducible_query: query,
    },
  };
}
