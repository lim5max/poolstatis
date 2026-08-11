import type { Funnel } from '../api/types';
import {
  resolveTemplateCapability,
  type AnalysisCapability,
  type AnalysisTemplate,
} from './templates';
import type { AnalysisQueryInput, QueryInterval } from './visualization';

export type MetricView = 'trend' | 'lifecycle' | 'stickiness';

export function comparisonControl() {
  return {
    label: 'Previous exact period',
    disabled: true,
    reason: 'Runs an adjacent window with identical duration when a safe headline aggregation exists',
  } as const;
}

export function scenarioPickerOptions(
  templates: AnalysisTemplate[],
  capabilities: ReadonlySet<AnalysisCapability>,
) {
  const reasons: Partial<Record<AnalysisCapability, string>> = {
    'web.analytics': 'Requires web analytics',
    'release.evidence': 'Requires release evidence',
    'experiment.results': 'Requires experiment evidence',
    'measurement.trust': 'Requires trust analysis',
  };
  return templates.map((template) => {
    const capability = resolveTemplateCapability(template.key, capabilities);
    return {
      key: template.key,
      label: template.title,
      disabled: capability.status === 'unavailable',
      reason: capability.missing[0] ? reasons[capability.missing[0]] ?? 'Not available yet' : null,
    };
  });
}

export function buildProductQuery(input: {
  template: AnalysisTemplate;
  metricView: MetricView;
  selectedKey: string;
  selectedFunnel?: Funnel;
  env: string;
  interval: QueryInterval;
  breakdown: string;
  dates: { from: string; to: string };
}): AnalysisQueryInput {
  const base = { date_from: input.dates.from, date_to: input.dates.to, env: input.env };
  if (input.template.key === 'activation-funnel') {
    return { kind: 'funnel', funnel: input.selectedFunnel?.key ?? input.selectedKey, ...base };
  }
  if (input.template.key === 'retention') {
    return {
      kind: 'retention',
      start_metric: input.selectedKey,
      interval: normalizeInterval(input.interval),
      periods: input.interval === 'month' ? 3 : input.interval === 'week' ? 8 : 14,
      ...base,
    };
  }
  if (input.metricView === 'lifecycle') {
    return { kind: 'lifecycle', metric: input.selectedKey, interval: normalizeInterval(input.interval), ...base };
  }
  if (input.metricView === 'stickiness') {
    return { kind: 'stickiness', metric: input.selectedKey, interval: normalizeInterval(input.interval), ...base };
  }
  return {
    kind: 'trend',
    metric: input.selectedKey,
    interval: input.interval,
    filters: [],
    ...(input.breakdown !== 'none' ? { breakdown: { property: input.breakdown } } : {}),
    ...base,
  };
}

export function visualizationTitle(templateTitle: string, definitionTitle: string) {
  return templateTitle.localeCompare(definitionTitle, undefined, { sensitivity: 'base' }) === 0
    ? templateTitle
    : `${templateTitle} · ${definitionTitle}`;
}

export function safeQueryError(_caught: unknown) {
  return 'Query unavailable. Retry, change the range, or inspect the definition.';
}

function normalizeInterval(interval: QueryInterval): Exclude<QueryInterval, 'hour'> {
  return interval === 'hour' ? 'day' : interval;
}
