import type { AnswerBlock, EvidenceBlock } from '../api/types';

export type QueryInterval = 'hour' | 'day' | 'week' | 'month';
export type PropertyFilter = {
  property: string;
  op: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'contains' | 'is_set' | 'is_not_set';
  value?: string | number | boolean | Array<string | number>;
};

interface QueryBase {
  date_from: string;
  date_to?: string | null;
  env: string;
}

export interface TrendQueryInput extends QueryBase {
  kind: 'trend';
  metric: string;
  interval: QueryInterval;
  filters: PropertyFilter[];
  breakdown?: { property: string };
}

export interface FunnelQueryInput extends QueryBase {
  kind: 'funnel';
  funnel?: string;
  steps?: Array<{ metric: string }>;
}

export interface RetentionQueryInput extends QueryBase {
  kind: 'retention';
  start_metric: string;
  return_metric?: string;
  interval: Exclude<QueryInterval, 'hour'>;
  periods: number;
}

export interface LifecycleQueryInput extends QueryBase {
  kind: 'lifecycle';
  metric: string;
  interval: Exclude<QueryInterval, 'hour'>;
}

export interface StickinessQueryInput extends QueryBase {
  kind: 'stickiness';
  metric: string;
  interval: Exclude<QueryInterval, 'hour'>;
}

export type AnalysisQueryInput =
  | TrendQueryInput
  | FunnelQueryInput
  | RetentionQueryInput
  | LifecycleQueryInput
  | StickinessQueryInput;

export interface QueryMeta {
  computed_at: string;
  date_range: { from: string; to: string };
  sampling: number | null;
  source: 'native' | 'posthog';
  note?: string;
}

export interface TrendQueryResult {
  kind: 'trend';
  series: Array<{ bucket: string; value: number; breakdown_value?: string }>;
  answer?: AnswerBlock;
  evidence?: EvidenceBlock;
  meta: QueryMeta;
}

export interface FunnelQueryResult {
  kind: 'funnel';
  steps: Array<{
    label: string;
    metric_key: string;
    purpose: string;
    category: string | null;
    actors: number;
    conversion_from_prev: number | null;
    conversion_from_start: number | null;
  }>;
  summary?: {
    overall_conversion: number | null;
    previous_overall_conversion: number | null;
    delta_percentage_points: number | null;
    biggest_absolute_loss: FunnelLoss | null;
    biggest_percentage_loss: FunnelLoss | null;
  };
  answer?: AnswerBlock;
  evidence?: EvidenceBlock;
  meta: QueryMeta;
}

export interface FunnelLoss {
  from_step: number;
  to_step: number;
  lost_actors: number;
  drop_rate: number | null;
}

export interface RetentionQueryResult {
  kind: 'retention';
  interval: Exclude<QueryInterval, 'hour'>;
  cohorts: Array<{
    cohort: string;
    size: number;
    retained: number[];
    retained_pct: number[];
    mature_periods: number;
  }>;
  meta: QueryMeta;
}

export interface LifecycleQueryResult {
  kind: 'lifecycle';
  interval: Exclude<QueryInterval, 'hour'>;
  series: Array<{ bucket: string; new: number; returning: number; resurrecting: number; dormant: number }>;
  meta: QueryMeta;
}

export interface StickinessQueryResult {
  kind: 'stickiness';
  interval: Exclude<QueryInterval, 'hour'>;
  bins: Array<{ intervals_active: number; actors: number }>;
  meta: QueryMeta;
}

export type AnalysisQueryResult =
  | TrendQueryResult
  | FunnelQueryResult
  | RetentionQueryResult
  | LifecycleQueryResult
  | StickinessQueryResult;

export type VisualizationKind =
  | 'metric_value'
  | 'trend'
  | 'breakdown'
  | 'funnel'
  | 'retention_matrix'
  | 'retention_curve'
  | 'stickiness'
  | 'lifecycle'
  | 'release_impact'
  | 'experiment_result'
  | 'trust_summary'
  | 'actor_timeline';

export type VisualizationAction =
  | { kind: 'open_metric'; key: string }
  | { kind: 'open_funnel'; key: string }
  | { kind: 'open_query'; query: AnalysisQueryInput }
  | { kind: 'see_actors'; actorQuery: Record<string, unknown> }
  | { kind: 'compare_segment'; allowedProperties: string[] }
  | { kind: 'annotate_release'; releaseId: string }
  | { kind: 'open_decision'; decisionId: string }
  | { kind: 'save_view' };

export interface VisualizationSpec {
  schemaVersion: 1;
  id: string;
  kind: VisualizationKind;
  title: string;
  question: string;
  purpose: string;
  project: string;
  env: string;
  range: { from: string; to: string; timezone: 'UTC' };
  source:
    | { kind: 'metric'; key: string; query: AnalysisQueryInput }
    | { kind: 'funnel'; key: string; query: AnalysisQueryInput }
    | { kind: 'release'; id: string }
    | { kind: 'experiment'; key: string }
    | { kind: 'trust_report'; key: string };
  trust: {
    status: 'trusted' | 'partial' | 'blocked' | 'unavailable';
    reason: string;
    blockers: Array<{ code: string; message: string; nextAction?: string }>;
  };
  evidence: {
    aggregation: string;
    denominator: string | null;
    sampleSize: number | null;
    coverage: string;
    source: 'native' | 'posthog' | 'registry' | 'release' | 'experiment';
    computedAt: string;
    comparisonBasis: string;
  };
  display: {
    valueFormat?: 'number' | 'percent' | 'duration' | 'currency';
    granularity?: QueryInterval;
    compare?: 'previous_period' | 'none';
    series: Array<{ key: string; label: string; colorToken: string }>;
  };
  actions: VisualizationAction[];
}

const QUERY_KINDS = new Set(['trend', 'funnel', 'retention', 'lifecycle', 'stickiness']);
const QUERY_INTERVALS = new Set<QueryInterval>(['hour', 'day', 'week', 'month']);
const COHORT_INTERVALS = new Set<Exclude<QueryInterval, 'hour'>>(['day', 'week', 'month']);
const FILTER_OPERATORS = new Set<PropertyFilter['op']>([
  'eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'contains', 'is_set', 'is_not_set',
]);
const VISUALIZATION_KINDS = new Set<VisualizationKind>([
  'metric_value', 'trend', 'breakdown', 'funnel', 'retention_matrix', 'retention_curve',
  'stickiness', 'lifecycle', 'release_impact', 'experiment_result', 'trust_summary', 'actor_timeline',
]);
const SOURCE_KINDS = new Set(['metric', 'funnel', 'release', 'experiment', 'trust_report']);
const TRUST_STATUSES = new Set(['trusted', 'partial', 'blocked', 'unavailable']);
const EVIDENCE_SOURCES = new Set(['native', 'posthog', 'registry', 'release', 'experiment']);
const ACTION_KINDS = new Set([
  'open_metric',
  'open_funnel',
  'open_query',
  'see_actors',
  'compare_segment',
  'annotate_release',
  'open_decision',
  'save_view',
]);

function validRegistryQuery(value: unknown): value is AnalysisQueryInput {
  if (!value || typeof value !== 'object') return false;
  const query = value as Record<string, unknown>;
  if (typeof query.kind !== 'string' || !QUERY_KINDS.has(query.kind)
    || !nonEmptyString(query.env) || !validIsoDate(query.date_from)
    || !validIsoDate(query.date_to) || Date.parse(query.date_from) > Date.parse(query.date_to)) {
    return false;
  }
  if (query.kind === 'trend') {
    return validRegistryKey(query.metric)
      && typeof query.interval === 'string' && QUERY_INTERVALS.has(query.interval as QueryInterval)
      && Array.isArray(query.filters) && query.filters.length <= 20 && query.filters.every(validPropertyFilter)
      && (query.breakdown === undefined
        || (Boolean(query.breakdown) && typeof query.breakdown === 'object'
          && nonEmptyString((query.breakdown as Record<string, unknown>).property)));
  }
  if (query.kind === 'funnel') {
    const hasFunnel = query.funnel !== undefined;
    const hasSteps = query.steps !== undefined;
    if (hasFunnel === hasSteps) return false;
    if (hasFunnel) return validRegistryKey(query.funnel);
    return Array.isArray(query.steps)
      && query.steps.length >= 2
      && query.steps.every((step) => Boolean(step) && typeof step === 'object'
        && validRegistryKey((step as Record<string, unknown>).metric));
  }
  if (query.kind === 'retention') {
    return validRegistryKey(query.start_metric)
      && (query.return_metric === undefined || validRegistryKey(query.return_metric))
      && typeof query.interval === 'string' && COHORT_INTERVALS.has(query.interval as Exclude<QueryInterval, 'hour'>)
      && Number.isInteger(query.periods) && Number(query.periods) >= 2 && Number(query.periods) <= 31;
  }
  return validRegistryKey(query.metric)
    && typeof query.interval === 'string'
    && COHORT_INTERVALS.has(query.interval as Exclude<QueryInterval, 'hour'>);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function validRegistryKey(value: unknown): value is string {
  return typeof value === 'string'
    && value.length >= 1
    && value.length <= 100
    && /^[a-z][a-z0-9_]*$/.test(value);
}

function validIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return false;
  return new Date(value).toISOString() === value;
}

function validPropertyFilter(value: unknown): value is PropertyFilter {
  if (!value || typeof value !== 'object') return false;
  const filter = value as Record<string, unknown>;
  if (!nonEmptyString(filter.property) || typeof filter.op !== 'string'
    || !FILTER_OPERATORS.has(filter.op as PropertyFilter['op'])) return false;
  if (filter.op === 'is_set' || filter.op === 'is_not_set') return filter.value === undefined;
  if (Array.isArray(filter.value)) {
    return filter.value.every((item) => typeof item === 'string' || typeof item === 'number');
  }
  return typeof filter.value === 'string'
    || typeof filter.value === 'number'
    || typeof filter.value === 'boolean';
}

function querySourceKey(query: AnalysisQueryInput): string {
  if (query.kind === 'funnel') return query.funnel ?? 'inline';
  if (query.kind === 'retention') return query.start_metric;
  return query.metric;
}

function queryMatchesVisualization(kind: VisualizationKind, query: AnalysisQueryInput): boolean {
  if (query.kind === 'trend') return kind === 'trend' || kind === 'breakdown';
  if (query.kind === 'retention') return kind === 'retention_matrix' || kind === 'retention_curve';
  return kind === query.kind;
}

export function validateVisualizationSpec(value: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!value || typeof value !== 'object') return { valid: false, errors: ['spec must be an object'] };
  const spec = value as Partial<VisualizationSpec>;
  if (spec.schemaVersion !== 1) errors.push('schemaVersion must equal 1');
  if (!spec.kind || !VISUALIZATION_KINDS.has(spec.kind)) errors.push('kind is unsupported');
  if (!spec.id || !spec.title || !spec.question || !spec.purpose) errors.push('id and semantic labels are required');
  if (!spec.project || !spec.env) errors.push('project and env are required');
  if (!spec.range || spec.range.timezone !== 'UTC' || !spec.range.from || !spec.range.to
    || !Number.isFinite(Date.parse(spec.range.from)) || !Number.isFinite(Date.parse(spec.range.to))
    || Date.parse(spec.range.from) > Date.parse(spec.range.to)) {
    errors.push('exact UTC range is required');
  }
  let sourceQuery: AnalysisQueryInput | null = null;
  if (!spec.source) {
    errors.push('source is required');
  } else {
    const source = spec.source as unknown as Record<string, unknown>;
    if (!SOURCE_KINDS.has(String(source.kind))) {
      errors.push('source kind is unsupported');
    } else if (source.kind === 'metric' || source.kind === 'funnel') {
      if (!validRegistryKey(source.key) || !validRegistryQuery(source.query)) {
        errors.push('source query must be a supported registry-backed Query DSL branch');
      } else {
        sourceQuery = source.query;
        if (source.kind === 'metric' && sourceQuery.kind === 'funnel') {
          errors.push('metric source cannot execute a funnel query');
        }
        if (source.kind === 'funnel' && sourceQuery.kind !== 'funnel') {
          errors.push('funnel source must execute a funnel query');
        }
        if (source.key !== querySourceKey(sourceQuery)) errors.push('source key must match the registry query');
        if (spec.env !== sourceQuery.env
          || spec.range?.from !== sourceQuery.date_from
          || spec.range?.to !== sourceQuery.date_to) {
          errors.push('source query scope must match the visualization scope');
        }
        if (spec.kind && !queryMatchesVisualization(spec.kind, sourceQuery)) {
          errors.push('visualization kind must match the source query branch');
        }
      }
    } else if (source.kind === 'release') {
      if (typeof source.id !== 'string' || !source.id) errors.push('release source id is required');
    } else if (typeof source.key !== 'string' || !source.key) {
      errors.push(`${String(source.kind)} source key is required`);
    }
  }
  if (!spec.trust?.status || !TRUST_STATUSES.has(spec.trust.status) || !spec.trust.reason || !Array.isArray(spec.trust.blockers)) {
    errors.push('trust context is required');
  }
  if (!spec.evidence?.aggregation || !EVIDENCE_SOURCES.has(String(spec.evidence.source))
    || !spec.evidence.computedAt || !Number.isFinite(Date.parse(spec.evidence.computedAt))
    || !spec.evidence.comparisonBasis) {
    errors.push('evidence context is required');
  }
  if (!spec.display || !Array.isArray(spec.display.series)
    || (spec.display.compare !== 'none' && spec.display.compare !== 'previous_period')
    || spec.display.series.some((series) => !series.key || !series.label || !/^--chart-[1-5]$/.test(series.colorToken))) {
    errors.push('display series are required');
  }
  if (!Array.isArray(spec.actions)) {
    errors.push('actions are required');
  } else {
    for (const typedAction of spec.actions) {
      const action = typedAction as unknown as Record<string, unknown>;
      if (!ACTION_KINDS.has(String(action.kind))) {
        errors.push('action kind is unsupported');
      } else if (action.kind === 'open_query') {
        if (!validRegistryQuery(action.query)
          || (sourceQuery && JSON.stringify(action.query) !== JSON.stringify(sourceQuery))) {
          errors.push('open_query action is not reproducible');
        }
      } else if ((action.kind === 'open_metric' || action.kind === 'open_funnel')
        && !validRegistryKey(action.key)) {
        errors.push(`${String(action.kind)} action key is required`);
      } else if (action.kind === 'see_actors' && (!action.actorQuery || typeof action.actorQuery !== 'object')) {
        errors.push('see_actors action query is required');
      } else if (action.kind === 'compare_segment'
        && (!Array.isArray(action.allowedProperties) || action.allowedProperties.some((property) => typeof property !== 'string'))) {
        errors.push('compare_segment action properties are required');
      } else if (action.kind === 'annotate_release' && (typeof action.releaseId !== 'string' || !action.releaseId)) {
        errors.push('annotate_release action id is required');
      } else if (action.kind === 'open_decision' && (typeof action.decisionId !== 'string' || !action.decisionId)) {
        errors.push('open_decision action id is required');
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

export type VisualizationRenderState = 'loading' | 'unavailable' | 'error' | 'empty' | 'ready';

export function resolveRenderState(input: {
  capability: boolean;
  loading: boolean;
  error: string | null;
  pointCount: number;
}): VisualizationRenderState {
  if (!input.capability) return 'unavailable';
  if (input.loading) return 'loading';
  if (input.error) return 'error';
  if (input.pointCount === 0) return 'empty';
  return 'ready';
}

export function countResultPoints(result: AnalysisQueryResult): number {
  if (result.kind === 'trend' || result.kind === 'lifecycle') return result.series.length;
  if (result.kind === 'funnel') return result.steps.length;
  if (result.kind === 'retention') return result.cohorts.length;
  return result.bins.length;
}

export type ManualRenderer =
  | 'trend'
  | 'breakdown'
  | 'funnel'
  | 'retention_matrix'
  | 'retention_curve'
  | 'stickiness'
  | 'lifecycle';

export function resolveManualRenderer(
  kind: VisualizationKind,
  resultKind: AnalysisQueryResult['kind'],
): ManualRenderer | null {
  if (resultKind === 'trend' && (kind === 'trend' || kind === 'breakdown')) return kind;
  if (resultKind === 'funnel' && kind === 'funnel') return 'funnel';
  if (resultKind === 'retention' && (kind === 'retention_matrix' || kind === 'retention_curve')) return kind;
  if (resultKind === 'stickiness' && kind === 'stickiness') return 'stickiness';
  if (resultKind === 'lifecycle' && kind === 'lifecycle') return 'lifecycle';
  return null;
}
