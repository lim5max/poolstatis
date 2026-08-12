import type {
  DataQualityIssue,
  Funnel,
  IngestWarning,
  MeasurementContract,
  MeasurementTrust,
  Metric,
  MetricUsage,
  ObservedEvent,
  PropertyDefinition,
  Release,
  SavedAnswer,
  SourceConnection,
} from '../api/types';
import type { AnalysisQueryInput, AnalysisQueryResult } from './visualization';

const DAY = 86_400_000;

export interface StandardAnswerSummary {
  takeaway: string;
  currentValue: number | null;
  previousValue: number | null;
  delta: number | null;
  deltaPercent: number | null;
  comparison: string;
  followUp: string;
}

export function previousPeriodQuery(query: AnalysisQueryInput): AnalysisQueryInput {
  if (!('date_from' in query)) return query;
  const from = Date.parse(query.date_from);
  const to = Date.parse(query.date_to ?? new Date().toISOString());
  const duration = Math.max(to - from, 1);
  return {
    ...query,
    date_from: new Date(from - duration).toISOString(),
    date_to: new Date(from).toISOString(),
  } as AnalysisQueryInput;
}

export function summarizeAnswer(
  title: string,
  current: AnalysisQueryResult,
  previous: AnalysisQueryResult | null,
  context: { metric?: Pick<Metric, 'type' | 'source'>; breakdown?: string } = {},
): StandardAnswerSummary {
  const currentValue = answerValue(current, context);
  const previousValue = previous?.kind === current.kind ? answerValue(previous, context) : null;
  const delta = currentValue !== null && previousValue !== null ? currentValue - previousValue : null;
  const deltaPercent = delta !== null && previousValue !== null && previousValue !== 0
    ? delta / Math.abs(previousValue)
    : null;
  const movement = deltaPercent === null
    ? 'Previous-period comparison is unavailable.'
    : Math.abs(deltaPercent) < 0.005
      ? 'It is stable versus the previous period.'
      : `${deltaPercent > 0 ? 'Up' : 'Down'} ${formatPercent(Math.abs(deltaPercent))} versus the previous period.`;
  return {
    takeaway: currentValue === null
      ? `${title} is rendered, but this result has no safely comparable period headline.`
      : `${title} is ${formatAnswerValue(current, currentValue)}. ${movement}`,
    currentValue,
    previousValue,
    delta,
    deltaPercent,
    comparison: currentValue === null || previousValue === null ? 'No safely comparable period headline' : 'Previous exact period',
    followUp: deltaPercent !== null && Math.abs(deltaPercent) >= 0.1
      ? 'Break this movement down by one trusted property.'
      : 'Extend the range or inspect the metric definition before acting.',
  };
}

function answerValue(
  result: AnalysisQueryResult,
  context: { metric?: Pick<Metric, 'type' | 'source'>; breakdown?: string },
): number | null {
  if (result.kind === 'trend') {
    if (context.breakdown && context.breakdown !== 'none') return null;
    if (context.metric?.type === 'count') return result.series.reduce((sum, point) => sum + point.value, 0);
    const source = context.metric?.source as { agg?: string } | undefined;
    if (context.metric?.type === 'value' && source?.agg === 'sum') {
      return result.series.reduce((sum, point) => sum + point.value, 0);
    }
    return null;
  }
  if (result.kind === 'funnel') return result.steps.at(-1)?.conversion_from_start ?? null;
  if (result.kind === 'retention') {
    const mature = result.cohorts.filter((cohort) => cohort.mature_periods > 0 && cohort.retained_pct[0] !== undefined);
    if (mature.length === 0) return null;
    const denominator = mature.reduce((sum, cohort) => sum + cohort.size, 0);
    if (denominator === 0) return null;
    return mature.reduce((sum, cohort) => sum + cohort.size * (cohort.retained_pct[0] ?? 0), 0) / denominator;
  }
  if (result.kind === 'stickiness') return result.bins.reduce((sum, bin) => sum + bin.actors, 0);
  const last = result.series.at(-1);
  return last ? last.new + last.returning + last.resurrecting : null;
}

function formatAnswerValue(result: AnalysisQueryResult, value: number): string {
  return result.kind === 'funnel' || result.kind === 'retention'
    ? formatPercent(value)
    : new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);
}

function formatPercent(value: number): string {
  return new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 1 }).format(value);
}

export interface ReadinessGroup {
  key: 'tracking' | 'properties' | 'identity' | 'sources';
  healthy: number;
  incomplete: number;
  affectedAnswers: string[];
  fixNext: string;
}

export function buildMeasurementReadiness(input: {
  trust: Array<{ metric: Metric; trust: MeasurementTrust | null; error: string | null }>;
  properties: PropertyDefinition[];
  activeLinks: number;
  sources: SourceConnection[];
  contracts: MeasurementContract[];
}): ReadinessGroup[] {
  const trusted = input.trust.filter((row) => row.trust?.status === 'trusted').length;
  const untrusted = input.trust.length - trusted;
  const trustedProperties = input.properties.filter((property) => property.status === 'trusted').length;
  const sourceIssues = input.sources.filter((source) => source.status === 'configured' || source.status === 'error').length;
  const invalidContracts = input.contracts.filter((contract) => contract.status !== 'active').length;
  return [
    {
      key: 'tracking',
      healthy: trusted,
      incomplete: untrusted + invalidContracts,
      affectedAnswers: untrusted + invalidContracts > 0 ? ['Product answers', 'Funnels', 'Release decisions'] : [],
      fixNext: untrusted > 0 ? 'Review the first trust blocker on an active metric.' : invalidContracts > 0 ? 'Activate or repair the measurement contract.' : 'No tracking-plan fix required.',
    },
    {
      key: 'properties',
      healthy: trustedProperties,
      incomplete: input.properties.length - trustedProperties,
      affectedAnswers: trustedProperties === 0 ? ['Trusted breakdowns', 'Web acquisition answers'] : [],
      fixNext: input.properties.length === trustedProperties ? 'No property-definition fix required.' : 'Review meaning, type, and observed coverage before trusting a breakdown.',
    },
    {
      key: 'identity',
      healthy: input.activeLinks > 0 ? 1 : 0,
      incomplete: input.activeLinks > 0 ? 0 : 1,
      affectedAnswers: input.activeLinks > 0 ? [] : ['Canonical People', 'Cross-device funnels'],
      fixNext: input.activeLinks > 0 ? 'Identity links have server-owned provenance.' : 'Instrument an explicit anonymous-to-stable identity link.',
    },
    {
      key: 'sources',
      healthy: input.sources.length - sourceIssues + 1,
      incomplete: sourceIssues,
      affectedAnswers: sourceIssues > 0 ? ['External-source answers'] : [],
      fixNext: sourceIssues > 0 ? 'Repair or disconnect the failing external source.' : 'Native accepted events remain the default source.',
    },
  ];
}

export interface HealthFinding {
  code: string;
  title: string;
  detail: string;
  affected: string[];
  verify: string;
}

export function buildDataHealth(input: {
  observed: ObservedEvent[];
  issues: DataQualityIssue[];
  checked: { terminal_event_specs: number; evidence_rows: number };
  warnings: IngestWarning[];
  metrics: Metric[];
  now?: Date;
}): { improvements: HealthFinding[]; doingGreat: HealthFinding[]; coverage: number } {
  const total = input.observed.reduce((sum, event) => sum + event.count, 0);
  const registered = input.observed.reduce((sum, event) => sum + event.count * event.registered_share, 0);
  const coverage = total === 0 ? 1 : registered / total;
  const improvements: HealthFinding[] = [];
  const doingGreat: HealthFinding[] = [];
  const recentCutoff = (input.now ?? new Date()).getTime() - 7 * DAY;
  const recentWarnings = input.warnings.filter((warning) => Date.parse(warning.last_seen) >= recentCutoff);
  const rejected = recentWarnings.filter((warning) => warning.kind === 'rejected');
  const offStandard = input.observed.filter((event) => event.registered_share < 0.999);
  if (rejected.length > 0) improvements.push({
    code: 'recent_rejections', title: `${rejected.length} recent rejection signature${rejected.length === 1 ? '' : 's'}`,
    detail: 'At least one rejected signature was observed in the last 7 days. Aggregated warning counts are lifetime counts, not a false time-series.',
    affected: affectedMetrics(rejected.map((item) => item.event), input.metrics),
    verify: 'Send one corrected event, require HTTP 200, then confirm no new rejection watermark.',
  });
  if (offStandard.length > 0) improvements.push({
    code: 'off_standard', title: `${offStandard.length} off-standard event name${offStandard.length === 1 ? '' : 's'}`,
    detail: `${formatPercent(coverage)} of 30-day volume matches active metric sources.`,
    affected: ['Registry coverage', 'Any answer expecting these event names'],
    verify: 'Register the intended metric or correct the producer, then verify registered coverage on fresh events.',
  });
  if (input.issues.length > 0) improvements.push({
    code: 'entity_conflicts', title: `${input.issues.length} entity/event consistency conflict${input.issues.length === 1 ? '' : 's'}`,
    detail: 'Immutable terminal-event evidence disagrees with current entity state.',
    affected: ['Entity answers', 'State metrics'],
    verify: 'Correct the mutable entity state and rerun the consistency check.',
  });
  if (input.checked.terminal_event_specs === 0) improvements.push({
    code: 'terminal_specs_missing', title: 'Entity consistency is not configured',
    detail: 'No active metric source maps to a supported terminal entity event, so entity status cannot be checked.',
    affected: ['Entity answers', 'State metrics'],
    verify: 'Activate a terminal entity event metric, send matching evidence, then rerun the consistency check.',
  }); else if (input.checked.evidence_rows === 0) improvements.push({
    code: 'terminal_evidence_missing', title: 'No comparable entity evidence in 30 days',
    detail: 'Terminal event rules exist, but no event/entity pair with a current status was available to compare.',
    affected: ['Entity answers', 'State metrics'],
    verify: 'Send a terminal event with an entity ID and confirm the matching entity has a current status.',
  });
  if (total === 0) improvements.push({
    code: 'no_events', title: 'No accepted events in 30 days', detail: 'Integration health cannot be assessed without accepted evidence.',
    affected: ['Product answers', 'Funnels', 'People'], verify: 'Send a registered sample event and confirm it appears in the event stream.',
  });
  if (rejected.length === 0) doingGreat.push({ code: 'no_recent_rejections', title: 'No recent rejection signatures', detail: 'The warning log has no signature last seen in the past 7 days.', affected: [], verify: 'Keep the ingest warnings check in release verification.' });
  if (offStandard.length === 0 && total > 0) doingGreat.push({ code: 'registered_coverage', title: 'All accepted volume is registered', detail: 'Observed 30-day events map to active registry sources.', affected: [], verify: 'Recheck after instrumentation releases.' });
  if (input.checked.terminal_event_specs > 0 && input.checked.evidence_rows > 0 && input.issues.length === 0) {
    doingGreat.push({ code: 'entity_consistency', title: 'Entity state matches terminal events', detail: `${input.checked.evidence_rows} comparable entity record${input.checked.evidence_rows === 1 ? '' : 's'} had no current conflict.`, affected: [], verify: 'Rerun after backfills or state migrations.' });
  }
  return { improvements, doingGreat, coverage };
}

function affectedMetrics(events: string[], metrics: Metric[]): string[] {
  const names = new Set(events);
  return metrics.filter((metric) => metricSourceEvents(metric).some((event) => names.has(event))).map((metric) => metric.key);
}

function metricSourceEvents(metric: Metric): string[] {
  const source = metric.source as { event?: string; from?: { event?: string }; to?: { event?: string } };
  return [source.event, source.from?.event, source.to?.event].filter((value): value is string => Boolean(value));
}

export interface RegistryMetricHealth {
  key: string;
  incomplete: boolean;
  unused: boolean | null;
  usedByAnswers: string[];
  observedEvents: number | null;
}

export function buildRegistryHealth(
  metrics: Metric[],
  funnels: Funnel[],
  usages: Map<string, MetricUsage | null>,
  experiments: Array<{ key: string; primary_metric_key: string; secondary_metric_keys: string[] }> | null = [],
  savedAnswers: SavedAnswer[] | null = [],
  releases: Release[] | null = [],
): { healthy: number; proposed: number; incomplete: number; deprecated: number; unused: number; usageUnavailable: number; rows: RegistryMetricHealth[] } {
  const rows = metrics.map((metric): RegistryMetricHealth => {
    const usage = usages.get(metric.key) ?? null;
    const observedEvents = usage ? usage.observed_events.reduce((sum, item) => sum + item.count, 0) : null;
    const explicit = [
      ...(usage?.used_by.funnels.map((item) => `Funnel · ${item.name}`) ?? funnels.filter((funnel) => funnel.steps.some((step) => step.metric_key === metric.key)).map((funnel) => `Funnel · ${funnel.name}`)),
      ...(usage?.used_by.insights.map((item) => `Insight · ${item.title}`) ?? []),
      ...(experiments?.filter((experiment) => experiment.primary_metric_key === metric.key || experiment.secondary_metric_keys.includes(metric.key)).map((experiment) => `Experiment · ${experiment.key}`) ?? []),
      ...(savedAnswers?.filter((answer) => savedAnswerMetricRefs(answer).includes(metric.key)).map((answer) => `Saved answer · ${answer.title}`) ?? []),
      ...(releases?.filter((release) => release.contract_snapshot.primary_metric_key === metric.key || release.contract_snapshot.guardrail_metric_keys.includes(metric.key)).map((release) => `Release · ${release.commit_sha.slice(0, 7)}`) ?? []),
    ];
    const eventBased = metricSourceEvents(metric).length > 0;
    const answerSurfaces = metric.status === 'active' && metric.type !== 'conversion' && metric.type !== 'state'
      ? [
          'Product answer',
          ...(eventBased ? ['Retention answer'] : []),
          ...(isNativePeopleActivityMetric(metric) ? ['People activity filter'] : []),
        ]
      : [];
    return {
      key: metric.key,
      incomplete: metric.status === 'active' && observedEvents === 0,
      unused: metric.status !== 'active' || answerSurfaces.length > 0 || explicit.length > 0
        ? false
        : usage !== null && experiments !== null && savedAnswers !== null && releases !== null
          ? true
          : null,
      usedByAnswers: [...new Set([...answerSurfaces, ...explicit])],
      observedEvents,
    };
  });
  return {
    healthy: rows.filter((row) => {
      const metric = metrics.find((candidate) => candidate.key === row.key);
      return metric?.status === 'active' && (row.observedEvents ?? 0) > 0 && !row.incomplete && row.unused === false;
    }).length,
    proposed: metrics.filter((metric) => metric.status === 'proposed').length,
    incomplete: rows.filter((row) => row.incomplete).length,
    deprecated: metrics.filter((metric) => metric.status === 'deprecated').length,
    unused: rows.filter((row) => row.unused === true).length,
    usageUnavailable: rows.filter((row) => {
      const metric = metrics.find((candidate) => candidate.key === row.key);
      return row.unused === null || (metric?.status === 'active' && row.observedEvents === null);
    }).length,
    rows,
  };
}

function isNativePeopleActivityMetric(metric: Metric): boolean {
  if (metric.status !== 'active' || metric.type === 'conversion' || metric.type === 'state') return false;
  const source = metric.source as { event?: unknown; data_source?: unknown };
  return typeof source.event === 'string'
    && (source.data_source === undefined || source.data_source === 'native');
}

function savedAnswerMetricRefs(answer: SavedAnswer): string[] {
  const source = answer.visualization_spec.source;
  const primary = source.kind === 'metric' ? [source.key] : [];
  const evidence = answer.evidence.source_refs.flatMap((ref) =>
    ref.kind === 'metric' && typeof ref.key === 'string' ? [ref.key] : []);
  return [...new Set([...primary, ...evidence])];
}

export function credentialPermissions(kind: 'ingest' | 'secret' | 'personal'): string {
  if (kind === 'ingest') return 'Write accepted events to one project and environment; cannot read data.';
  if (kind === 'secret') return 'Read and manage one project; cannot access sibling projects.';
  return 'Read and manage every project in the issuing workspace.';
}
