import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ArrowRight, Loader2 } from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ErrorNote, Loading, Panel } from '@/components/ui';
import type { Funnel, MeasurementTrust, Metric } from '../api/types';
import { useAsync, useStore } from '../store';
import {
  ANALYSIS_TEMPLATES,
  CORE_ANALYZE_CAPABILITIES,
  resolveTemplateCapability,
  type AnalysisTemplate,
  type TimeRangePreset,
} from '../analysis/templates';
import { ManualVisualizationRenderer } from '../analysis/charts';
import {
  countResultPoints,
  resolveRenderState,
  type AnalysisQueryInput,
  type AnalysisQueryResult,
  type QueryInterval,
  type VisualizationSpec,
} from '../analysis/visualization';
import {
  buildProductQuery,
  comparisonControl,
  safeQueryError,
  scenarioPickerOptions,
  visualizationTitle,
  type MetricView,
} from '../analysis/product';

interface AnalysisRun {
  spec: VisualizationSpec;
  result: AnalysisQueryResult;
}

const OPTION_TARGET = 'min-h-11 md:min-h-8';

export function ProductAnalytics() {
  const { client, project, env } = useStore();
  const [params] = useSearchParams();
  const initialTemplate = ANALYSIS_TEMPLATES.find((template) => template.key === params.get('template') && resolveTemplateCapability(template.key, CORE_ANALYZE_CAPABILITIES).status === 'available')
    ?? ANALYSIS_TEMPLATES[0]!;
  const [templateKey, setTemplateKey] = useState(initialTemplate.key);
  const template = ANALYSIS_TEMPLATES.find((candidate) => candidate.key === templateKey) ?? ANALYSIS_TEMPLATES[0]!;
  const capability = resolveTemplateCapability(template.key, CORE_ANALYZE_CAPABILITIES);
  const scenarioOptions = scenarioPickerOptions(ANALYSIS_TEMPLATES, CORE_ANALYZE_CAPABILITIES);
  const registry = useAsync(async () => {
    const [metrics, funnels, properties] = await Promise.all([
      client!.metrics(project!, { status: 'active' }),
      client!.funnels(project!),
      client!.properties(project!, { status: 'trusted' }),
    ]);
    return {
      metrics,
      funnels,
      properties: properties.filter((property) => property.scope === 'event' && property.status === 'trusted'),
    };
  }, [project, env]);
  const [resourceKey, setResourceKey] = useState('');
  const [range, setRange] = useState<TimeRangePreset>(template.defaultRange);
  const [interval, setInterval] = useState<QueryInterval>('day');
  const [metricView, setMetricView] = useState<MetricView>('trend');
  const [breakdown, setBreakdown] = useState('none');
  const [run, setRun] = useState<AnalysisRun | null>(null);
  const [runError, setRunError] = useState<{ scope: string; message: string } | null>(null);
  const [running, setRunning] = useState(false);
  const runGeneration = useRef(0);
  const currentScope = `${project ?? 'none'}:${env}`;
  const scopeRef = useRef(currentScope);
  scopeRef.current = currentScope;
  const comparison = comparisonControl();

  useEffect(() => {
    runGeneration.current += 1;
    setResourceKey('');
    setRun(null);
    setRunError(null);
    setRunning(false);
    return () => {
      runGeneration.current += 1;
    };
  }, [project, env]);

  const compatibleMetrics = useMemo(
    () => (registry.data?.metrics ?? []).filter((metric) => metric.type !== 'conversion' && metric.type !== 'state'),
    [registry.data?.metrics],
  );
  const isFunnel = template.key === 'activation-funnel';
  const isRetention = template.key === 'retention';
  const resourceOptions = isFunnel ? registry.data?.funnels ?? [] : compatibleMetrics;
  const selectedKey = resourceOptions.some((resource) => resource.key === resourceKey)
    ? resourceKey
    : resourceOptions[0]?.key ?? '';

  const selectTemplate = (next: AnalysisTemplate) => {
    if (resolveTemplateCapability(next.key, CORE_ANALYZE_CAPABILITIES).status !== 'available') return;
    runGeneration.current += 1;
    setTemplateKey(next.key);
    setRange(next.defaultRange);
    setResourceKey('');
    setMetricView('trend');
    setInterval('day');
    setBreakdown('none');
    setRun(null);
    setRunError(null);
    setRunning(false);
  };

  const execute = async () => {
    if (!selectedKey || !registry.data) return;
    const generation = runGeneration.current + 1;
    runGeneration.current = generation;
    const runScope = currentScope;
    const runProject = project!;
    const runEnv = env;
    setRunning(true);
    setRunError(null);
    setRun(null);
    const dates = exactRange(range);
    const selectedMetric = compatibleMetrics.find((metric) => metric.key === selectedKey);
    const selectedFunnel = registry.data.funnels.find((funnel) => funnel.key === selectedKey);
    const query = buildProductQuery({
      template,
      metricView,
      selectedKey,
      selectedFunnel,
      env: runEnv,
      interval,
      breakdown,
      dates,
    });
    try {
      const result = await client!.query(runProject, query);
      if (generation !== runGeneration.current || scopeRef.current !== runScope) return;
      const metricKeys = queryMetricKeys(query, selectedFunnel);
      const trust = await readTrust(client!, runProject, runEnv, metricKeys, rangeDays(range));
      if (generation !== runGeneration.current || scopeRef.current !== runScope) return;
      const spec = createVisualizationSpec({
        project: runProject,
        env: runEnv,
        template,
        query,
        result,
        metric: selectedMetric,
        funnel: selectedFunnel,
        trust,
      });
      setRun({ spec, result });
    } catch (caught) {
      if (generation === runGeneration.current && scopeRef.current === runScope) {
        setRunError({ scope: runScope, message: safeQueryError(caught) });
      }
    } finally {
      if (generation === runGeneration.current && scopeRef.current === runScope) setRunning(false);
    }
  };

  const resetRun = () => {
    runGeneration.current += 1;
    setRun(null);
    setRunError(null);
    setRunning(false);
  };

  if (registry.loading) return <Loading what="reading registry capabilities…" />;
  if (registry.error) return <ErrorNote>{registry.error}</ErrorNote>;

  const currentRun = run?.spec.project === project && run.spec.env === env ? run : null;
  const currentRunError = runError?.scope === currentScope ? runError.message : null;
  const pointCount = currentRun ? countResultPoints(currentRun.result) : 0;
  const renderState = resolveRenderState({
    capability: capability.status === 'available',
    loading: running,
    error: currentRunError,
    pointCount,
  });

  return (
    <div className="space-y-5">
      <header className="max-w-3xl">
        <h1 className="serif text-3xl">Product analytics</h1>
      </header>

      <Panel title="Analysis setup" right={<Badge variant="outline">schema v1</Badge>}>
        <div className="grid gap-4 lg:grid-cols-[minmax(16rem,22rem)_minmax(0,1fr)] lg:items-end">
          <Control label="Scenario">
            <Select
              value={template.key}
              onValueChange={(value) => {
                const next = ANALYSIS_TEMPLATES.find((candidate) => candidate.key === value);
                if (next) selectTemplate(next);
              }}
            >
              <SelectTrigger className="!h-11 w-full" aria-label="Scenario">
                <SelectValue>{template.title}</SelectValue>
              </SelectTrigger>
              <SelectContent className="max-w-[calc(100vw-2rem)]">
                {scenarioOptions.map((option) => (
                  <SelectItem
                    key={option.key}
                    value={option.key}
                    disabled={option.disabled}
                    className="min-h-11 py-2"
                  >
                    <span className="flex min-w-0 flex-1 items-center justify-between gap-3">
                      <span className="truncate">{option.label}</span>
                      {option.reason && <span className="shrink-0 text-xs text-muted-foreground">{option.reason}</span>}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Control>
          <div className="min-w-0">
            <div className="text-sm font-medium">{template.question}</div>
            <p className="mt-1 text-sm text-muted-foreground">{template.purpose}</p>
          </div>
        </div>
        {capability.status === 'unavailable' ? (
          <div className="mt-5 rounded-panel border border-dashed p-4 text-sm text-muted-foreground">
            Unavailable · {capability.missing.map(friendlyCapability).join(', ')}
          </div>
        ) : resourceOptions.length === 0 ? (
          <div className="mt-5 rounded-panel border border-dashed p-5">
            <div className="font-medium">Required registry mapping is missing</div>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              {isFunnel
                ? 'Next: define a saved funnel with a goal and active metric steps.'
                : 'Next: activate an event-based metric with a concrete purpose.'}
            </p>
          </div>
        ) : (
          <div className="mt-5 grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
              <Control label={isFunnel ? 'Saved funnel' : 'Registry metric'}>
                <Select value={selectedKey} onValueChange={(value) => { setResourceKey(value); resetRun(); }}>
                  <SelectTrigger className="!h-11 w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {resourceOptions.map((resource) => <SelectItem className={OPTION_TARGET} key={resource.key} value={resource.key}>{resource.name} · {resource.key}</SelectItem>)}
                  </SelectContent>
                </Select>
              </Control>
              <Control label="Exact range">
                <Select value={range} onValueChange={(value) => { setRange(value as TimeRangePreset); resetRun(); }}>
                  <SelectTrigger className="!h-11 w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem className={OPTION_TARGET} value="7d">Last 7 days</SelectItem>
                    <SelectItem className={OPTION_TARGET} value="30d">Last 30 days</SelectItem>
                    <SelectItem className={OPTION_TARGET} value="90d">Last 90 days</SelectItem>
                  </SelectContent>
                </Select>
              </Control>
              {!isFunnel && !isRetention && (
                <Control label="Compatible view">
                  <Select value={metricView} onValueChange={(value) => { setMetricView(value as MetricView); resetRun(); }}>
                    <SelectTrigger className="!h-11 w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem className={OPTION_TARGET} value="trend">Trend</SelectItem>
                      <SelectItem className={OPTION_TARGET} value="lifecycle">Lifecycle</SelectItem>
                      <SelectItem className={OPTION_TARGET} value="stickiness">Stickiness</SelectItem>
                    </SelectContent>
                  </Select>
                </Control>
              )}
              {!isFunnel && !isRetention && metricView === 'trend' && (
                <Control label="Trusted breakdown">
                  <Select value={breakdown} onValueChange={(value) => { setBreakdown(value); resetRun(); }}>
                    <SelectTrigger className="!h-11 w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem className={OPTION_TARGET} value="none">No breakdown</SelectItem>
                      {(registry.data?.properties ?? []).map((property) => <SelectItem className={OPTION_TARGET} key={property.key} value={property.key}>{property.key}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </Control>
              )}
              {!isFunnel && (
                <Control label="Granularity">
                  <Select value={interval} onValueChange={(value) => { setInterval(value as QueryInterval); resetRun(); }}>
                    <SelectTrigger className="!h-11 w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {metricView === 'trend' && !isRetention && <SelectItem className={OPTION_TARGET} value="hour">Hour</SelectItem>}
                      <SelectItem className={OPTION_TARGET} value="day">Day</SelectItem>
                      <SelectItem className={OPTION_TARGET} value="week">Week</SelectItem>
                      <SelectItem className={OPTION_TARGET} value="month">Month</SelectItem>
                    </SelectContent>
                  </Select>
                </Control>
              )}
              <Control label="Comparison">
                <Button
                  type="button"
                  variant="outline"
                  className="h-11 min-w-0 justify-start truncate px-3"
                  disabled={comparison.disabled}
                  title={comparison.reason}
                  aria-label={`${comparison.label}. ${comparison.reason}`}
                >
                  {comparison.label}
                </Button>
              </Control>
            </div>
            <Button className="h-11 w-full lg:w-auto" onClick={execute} disabled={running || !selectedKey}>
              {running ? <Loader2 className="size-4 animate-spin" /> : <ArrowRight className="size-4" />}
              Run typed query
            </Button>
          </div>
        )}
      </Panel>

      {currentRunError && <ErrorNote>{currentRunError}</ErrorNote>}
      {renderState === 'loading' && <Panel><Loading what="executing server query…" /></Panel>}
      {renderState === 'empty' && currentRun && (
        <Panel>
          <div className="py-8 text-center">
            <div className="serif text-xl">No observations in this exact period</div>
            <p className="mx-auto mt-2 max-w-xl text-sm text-muted-foreground">Next: change the range or inspect the metric definition.</p>
          </div>
        </Panel>
      )}
      {renderState === 'ready' && currentRun && <ManualVisualizationRenderer spec={currentRun.spec} result={currentRun.result} />}
    </div>
  );
}

function Control({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="grid min-w-0 gap-1.5 text-xs font-medium text-muted-foreground">{label}{children}</label>;
}

function createVisualizationSpec(input: {
  project: string;
  env: string;
  template: AnalysisTemplate;
  query: AnalysisQueryInput;
  result: AnalysisQueryResult;
  metric?: Metric;
  funnel?: Funnel;
  trust: TrustRead;
}): VisualizationSpec {
  const source = input.query.kind === 'funnel'
    ? { kind: 'funnel' as const, key: input.funnel?.key ?? input.query.funnel ?? 'inline', query: input.query }
    : { kind: 'metric' as const, key: metricKey(input.query), query: input.query };
  const purpose = input.funnel?.goal ?? input.metric?.purpose ?? input.template.purpose;
  const spec: VisualizationSpec = {
    schemaVersion: 1,
    id: `${input.query.kind}:${source.key}:${input.env}:${input.result.meta.computed_at}`,
    kind: visualizationKind(input.query),
    title: visualizationTitle(input.template.title, input.funnel?.name ?? input.metric?.name ?? source.key),
    question: input.template.question,
    purpose,
    project: input.project,
    env: input.env,
    range: {
      from: input.result.meta.date_range.from,
      to: input.result.meta.date_range.to,
      timezone: 'UTC',
    },
    source,
    trust: input.trust.trust,
    evidence: {
      aggregation: aggregationLabel(input.query, input.metric, input.funnel),
      denominator: denominatorLabel(input.result),
      sampleSize: sampleSize(input.result, input.trust),
      coverage: input.trust.coverage,
      source: input.result.meta.source,
      computedAt: input.result.meta.computed_at,
      comparisonBasis: 'Current exact period only; previous-period comparison is unavailable.',
    },
    display: {
      valueFormat: input.query.kind === 'retention' || input.query.kind === 'funnel' ? 'percent' : 'number',
      granularity: 'interval' in input.query ? input.query.interval : undefined,
      compare: 'none',
      series: seriesFor(input.result, input.metric),
    },
    actions: [
      { kind: 'open_query', query: input.query },
      ...(source.kind === 'funnel' ? [{ kind: 'open_funnel' as const, key: source.key }] : [{ kind: 'open_metric' as const, key: source.key }]),
    ],
  };
  return spec;
}

interface TrustRead {
  trust: VisualizationSpec['trust'];
  results: MeasurementTrust[];
  coverage: string;
}

async function readTrust(
  client: NonNullable<ReturnType<typeof useStore>['client']>,
  project: string,
  env: string,
  metricKeys: string[],
  sinceDays: number,
): Promise<TrustRead> {
  try {
    const results = await Promise.all(metricKeys.map((metricKey) => client.measurementTrust(project, {
      metric_key: metricKey,
      env,
      since_days: sinceDays,
      target_filters: [],
    })));
    const blockers = results.flatMap((result) => result.blockers.map((blocker) => ({
      code: blocker.code,
      message: blocker.message,
      nextAction: blocker.next_action,
    })));
    const trusted = results.length > 0 && results.every((result) => result.status === 'trusted');
    const minCoverage = results.length > 0 ? Math.min(...results.map((result) => result.primary_metric.registered_coverage)) : null;
    return {
      results,
      coverage: minCoverage === null ? 'unavailable' : `${Math.round(minCoverage * 100)}% registered`,
      trust: {
        status: trusted ? 'trusted' : 'blocked',
        reason: trusted ? 'All selected registry metrics passed the server trust check.' : blockers[0]?.message ?? 'Measurement trust is incomplete.',
        blockers,
      },
    };
  } catch (caught) {
    return {
      results: [],
      coverage: 'unavailable',
      trust: {
        status: 'unavailable',
        reason: caught instanceof Error ? caught.message : 'Trust evidence could not be read.',
        blockers: [{ code: 'trust_unavailable', message: 'Trust evidence could not be read for this query.' }],
      },
    };
  }
}

function exactRange(preset: TimeRangePreset) {
  const to = new Date();
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - rangeDays(preset));
  return { from: from.toISOString(), to: to.toISOString() };
}

function rangeDays(preset: TimeRangePreset) {
  return preset === '7d' ? 7 : preset === '90d' ? 90 : 30;
}

function metricKey(query: AnalysisQueryInput) {
  if (query.kind === 'retention') return query.start_metric;
  if (query.kind === 'trend' || query.kind === 'lifecycle' || query.kind === 'stickiness') return query.metric;
  return query.steps?.[0]?.metric ?? query.funnel ?? '';
}

function queryMetricKeys(query: AnalysisQueryInput, funnel?: Funnel) {
  if (query.kind === 'funnel') return funnel?.steps.map((step) => step.metric_key) ?? query.steps?.map((step) => step.metric) ?? [];
  if (query.kind === 'retention') return [...new Set([query.start_metric, query.return_metric ?? query.start_metric])];
  return [query.metric];
}

function visualizationKind(query: AnalysisQueryInput): VisualizationSpec['kind'] {
  if (query.kind === 'trend') return query.breakdown ? 'breakdown' : 'trend';
  if (query.kind === 'funnel') return 'funnel';
  if (query.kind === 'retention') return 'retention_matrix';
  return query.kind;
}

function aggregationLabel(query: AnalysisQueryInput, metric?: Metric, funnel?: Funnel) {
  if (query.kind === 'trend') {
    if (metric?.type === 'unique_actors') return `unique actors per ${query.interval}`;
    if (metric?.type === 'value') return `registered value aggregation per ${query.interval}`;
    return `registered event count per ${query.interval}`;
  }
  if (query.kind === 'funnel') return `ordered actors within ${funnel?.window_seconds ?? 604800}s`;
  if (query.kind === 'retention') return `cohort return by ${query.interval}`;
  if (query.kind === 'lifecycle') return `actor lifecycle by ${query.interval}`;
  return `active ${query.interval} intervals per actor`;
}

function denominatorLabel(result: AnalysisQueryResult) {
  if (result.kind === 'funnel') return 'actors at first step';
  if (result.kind === 'retention') return 'actors in each cohort';
  return null;
}

function sampleSize(result: AnalysisQueryResult, trust: TrustRead) {
  if (result.kind === 'funnel') return result.steps[0]?.actors ?? 0;
  if (result.kind === 'retention') return result.cohorts.reduce((sum, cohort) => sum + cohort.size, 0);
  if (result.kind === 'stickiness') return result.bins.reduce((sum, bin) => sum + bin.actors, 0);
  return trust.results[0]?.primary_metric.observed_actors ?? null;
}

function seriesFor(result: AnalysisQueryResult, metric?: Metric): VisualizationSpec['display']['series'] {
  if (result.kind === 'trend') {
    const keys = [...new Set(result.series.map((point) => point.breakdown_value ?? 'value'))];
    return keys.map((key, index) => ({ key, label: key === 'value' ? metric?.name ?? 'Value' : key, colorToken: `--chart-${(index % 5) + 1}` }));
  }
  if (result.kind === 'funnel') return [{ key: 'actors', label: 'Actors', colorToken: '--chart-1' }];
  if (result.kind === 'retention') return [{ key: 'retained_pct', label: 'Retained', colorToken: '--chart-1' }];
  if (result.kind === 'stickiness') return [{ key: 'actors', label: 'Actors', colorToken: '--chart-3' }];
  return [
    { key: 'new', label: 'New', colorToken: '--chart-1' },
    { key: 'returning', label: 'Returning', colorToken: '--chart-2' },
    { key: 'resurrecting', label: 'Resurrecting', colorToken: '--chart-3' },
    { key: 'dormant', label: 'Dormant', colorToken: '--chart-4' },
  ];
}

function friendlyCapability(capability?: string) {
  const labels: Record<string, string> = {
    'web.analytics': 'web analytics is not available yet',
    'release.evidence': 'release evidence is not available here',
    'experiment.results': 'experiment evidence is not available here',
    'measurement.trust': 'trust analysis is not available here',
  };
  return capability ? labels[capability] ?? capability : 'unknown capability';
}
