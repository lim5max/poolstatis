import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowRight, Loader2 } from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ErrorNote, Loading } from '@/components/ui';
import { AnswerCanvas, CanonicalAnswer, type EvidenceTrust } from '@/components/analytics';
import { DisclosureSummary } from '@/components/disclosure';
import type { CreateSavedAnswerInput, Experiment, Funnel, MeasurementTrust, Metric, Release } from '../api/types';
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
  type FunnelQueryResult,
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
import { previousPeriodQuery as previousAnalysisPeriodQuery, summarizeAnswer, type StandardAnswerSummary } from '../analysis/semanticHealth';

interface AnalysisRun {
  spec: VisualizationSpec;
  result: AnalysisQueryResult;
  previousResult: AnalysisQueryResult | null;
  summary: StandardAnswerSummary;
  eventCount: number | null;
}

interface RequestedFunnelTransition {
  fromStep: number;
  toStep: number;
}

export interface RelatedFunnelEvidence {
  releases: Release[];
  experiments: Experiment[];
}

const OPTION_TARGET = 'min-h-11 md:min-h-8';

export function ProductAnalytics({ surface = 'product' }: { surface?: 'product' | 'funnels' } = {}) {
  const { client, project, env, tokenKind, account } = useStore();
  const [params] = useSearchParams();
  const funnelSurface = surface === 'funnels';
  const requestedFunnel = funnelSurface ? params.get('funnel') ?? '' : '';
  const requestedTransition = funnelSurface
    ? requestedFunnelTransition(params.get('from_step'), params.get('to_step'))
    : null;
  const initialTemplate = funnelSurface
    ? ANALYSIS_TEMPLATES.find((template) => template.key === 'activation-funnel')!
    : ANALYSIS_TEMPLATES.find((template) => template.key === params.get('template') && resolveTemplateCapability(template.key, CORE_ANALYZE_CAPABILITIES).status === 'available')
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
  const relatedEvidence = useAsync(async (): Promise<RelatedFunnelEvidence> => {
    if (!funnelSurface || !client || !project) return { releases: [], experiments: [] };
    const [releases, experiments] = await Promise.all([
      client.releases(project, { env }),
      client.experiments(project),
    ]);
    return { releases, experiments };
  }, [client, project, env, funnelSurface]);
  const [resourceKey, setResourceKey] = useState(requestedFunnel);
  const [range, setRange] = useState<TimeRangePreset>(template.defaultRange);
  const [interval, setInterval] = useState<QueryInterval>('day');
  const [metricView, setMetricView] = useState<MetricView>('trend');
  const [breakdown, setBreakdown] = useState('none');
  const [run, setRun] = useState<AnalysisRun | null>(null);
  const [runError, setRunError] = useState<{ scope: string; message: string } | null>(null);
  const [running, setRunning] = useState(false);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [officialSaveState, setOfficialSaveState] = useState<'idle' | 'saving' | 'saved' | 'saved_unofficial' | 'error'>('idle');
  const [savedAnswerId, setSavedAnswerId] = useState<string | null>(null);
  const officialSaveAllowed = tokenKind === 'personal'
    || (tokenKind === 'user'
      && (account?.membership.role === 'owner' || account?.membership.role === 'admin'));
  const runGeneration = useRef(0);
  const currentScope = `${project ?? 'none'}:${env}`;
  const scopeRef = useRef(currentScope);
  scopeRef.current = currentScope;
  const comparison = comparisonControl();

  useEffect(() => {
    runGeneration.current += 1;
    setResourceKey(requestedFunnel);
    setRun(null);
    setRunError(null);
    setRunning(false);
    setSaveState('idle');
    setOfficialSaveState('idle');
    setSavedAnswerId(null);
    return () => {
      runGeneration.current += 1;
    };
  }, [project, env, requestedFunnel]);

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
    setSaveState('idle');
    setOfficialSaveState('idle');
    setSavedAnswerId(null);
  };

  const execute = async () => {
    if (!selectedKey || !registry.data) return;
    const generation = runGeneration.current + 1;
    runGeneration.current = generation;
    const runScope = currentScope;
    const runProject = project!;
    const runEnv = env;
    setRunning(true);
    setSaveState('idle');
    setOfficialSaveState('idle');
    setSavedAnswerId(null);
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
      const previousResult = query.kind === 'funnel'
        ? null
        : await client!.query(runProject, previousAnalysisPeriodQuery(query)).catch(() => null);
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
        comparisonAvailable: result.kind === 'funnel'
          ? result.summary?.previous_overall_conversion !== null && result.summary?.previous_overall_conversion !== undefined
          : previousResult?.kind === result.kind,
      });
      setRun({
        spec,
        result,
        previousResult,
        summary: summarizeProductAnswer(spec.title, result, previousResult, {
          metric: selectedMetric,
          breakdown,
        }),
        eventCount: trust.results.length === 0
          ? null
          : trust.results.reduce((sum, item) => sum + item.primary_metric.observed_events, 0),
      });
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
    setSaveState('idle');
    setOfficialSaveState('idle');
    setSavedAnswerId(null);
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

  const saveAnswer = async (makeOfficial = false) => {
    if (!currentRun || !client || !project || saveState === 'saving' || officialSaveState === 'saving') return;
    if (makeOfficial && (!officialSaveAllowed || officialSaveState === 'saved')) return;
    if (!makeOfficial && saveState === 'saved') return;

    let answerId = savedAnswerId;
    if (!answerId) {
      setSaveState('saving');
      if (makeOfficial) setOfficialSaveState('saving');
      try {
        const saved = await client.createAnalysisView(project, savedAnswerInput(currentRun, template.key));
        answerId = saved.id;
        setSavedAnswerId(saved.id);
        setSaveState('saved');
      } catch {
        setSaveState('error');
        if (makeOfficial) setOfficialSaveState('error');
        return;
      }
    }

    if (!makeOfficial) return;
    setOfficialSaveState('saving');
    try {
      await client.setAnalysisViewOfficial(project, answerId, true);
      setOfficialSaveState('saved');
    } catch {
      setOfficialSaveState('saved_unofficial');
    }
  };

  return (
    <div className="space-y-5">
      <header className="max-w-3xl">
        <h1 className="serif text-3xl sm:text-4xl">{funnelSurface ? 'Funnels' : 'Product'}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {funnelSurface
            ? 'See where people stop before reaching a meaningful outcome.'
            : 'Start with a registered outcome. Open query controls only when the answer needs a closer look.'}
        </p>
      </header>

      {!funnelSurface && <section aria-labelledby="product-templates-title">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="product-templates-title" className="text-sm font-semibold">Answer templates</h2>
            <p className="mt-1 text-sm text-muted-foreground">Each answer stays inside the typed Query DSL.</p>
          </div>
          <Badge variant="outline">schema v1</Badge>
        </div>
        <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          {ANALYSIS_TEMPLATES.filter((candidate) => ['product-health', 'feature-adoption', 'retention', 'release-impact'].includes(candidate.key)).map((candidate) => {
            const available = resolveTemplateCapability(candidate.key, CORE_ANALYZE_CAPABILITIES).status === 'available';
            const selected = candidate.key === template.key;
            return (
              <button
                key={candidate.key}
                type="button"
                disabled={!available}
                aria-pressed={selected}
                onClick={() => selectTemplate(candidate)}
                className={`min-h-24 rounded-panel border p-3 text-left text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${selected ? 'border-brand-strong bg-primary/10' : available ? 'bg-card/55 hover:border-primary/60 hover:bg-primary/5' : 'cursor-not-allowed border-dashed bg-muted/25 text-muted-foreground'}`}
              >
                <span className="text-sm font-semibold">{candidate.title}</span>
                <span className="mt-1 block text-sm leading-relaxed text-muted-foreground">{available ? candidate.question : 'Not supported by the current server contract.'}</span>
              </button>
            );
          })}
        </div>
      </section>}

      <AnswerCanvas>
        <div className="flex flex-col gap-4 border-b px-4 py-4 sm:flex-row sm:items-end sm:justify-between sm:px-5">
          <div className="min-w-0">
            <div className="text-sm font-medium text-muted-foreground">{funnelSurface ? 'Funnel answer' : 'Current answer'}</div>
            <h2 className="mt-1 text-xl font-semibold">{template.title}</h2>
            <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{template.question}</p>
          </div>
          <Button variant={currentRun ? 'outline' : 'default'} className="h-11 shrink-0" onClick={execute} disabled={running || !selectedKey || capability.status !== 'available'}>
            {running ? <Loader2 className="size-4 animate-spin" /> : <ArrowRight className="size-4" />}
            {currentRun ? 'Refresh answer' : 'Run answer'}
          </Button>
        </div>
        {!selectedKey || capability.status === 'unavailable' ? (
          <div className="px-4 py-8 text-center sm:px-5">
            <div className="text-lg font-semibold">{capability.status === 'unavailable' ? 'This answer is not available yet' : 'Choose a registered outcome'}</div>
            <p className="mx-auto mt-2 max-w-xl text-sm text-muted-foreground">
              {capability.status === 'unavailable'
                ? capability.missing.map(friendlyCapability).join(', ')
                : isFunnel ? 'Save a funnel with a goal and active metric steps.' : 'Activate a metric with a concrete purpose.'}
            </p>
          </div>
        ) : !currentRun && !currentRunError && !running ? (
          <div className="px-4 py-8 text-center sm:px-5">
            <div className="text-lg font-semibold">Ready to read real data</div>
            <p className="mx-auto mt-2 max-w-xl text-sm text-muted-foreground">Run the prebuilt answer for <code>{selectedKey}</code>. Poolstatis will not substitute demo values.</p>
          </div>
        ) : null}
        {currentRunError && <div className="p-4 sm:p-5"><ErrorNote>{currentRunError}</ErrorNote></div>}
        {renderState === 'loading' && <Loading what="executing server query…" />}
        {renderState === 'empty' && currentRun && (
          <div className="px-4 py-8 text-center sm:px-5">
            <div className="text-lg font-semibold">No observations in this exact period</div>
            <p className="mx-auto mt-2 max-w-xl text-sm text-muted-foreground">Change the range or inspect the outcome definition.</p>
          </div>
        )}
      </AnswerCanvas>

      {funnelSurface && currentRun?.result.kind === 'funnel' && (
        <FunnelBiggestLoss
          funnel={registry.data?.funnels.find((item) => item.key === (currentRun.spec.source.kind === 'funnel' ? currentRun.spec.source.key : '')) ?? null}
          result={currentRun.result}
          requestedTransition={requestedTransition}
          relatedEvidence={relatedEvidence.data ?? { releases: [], experiments: [] }}
          relatedEvidenceUnavailable={Boolean(relatedEvidence.error)}
          env={env}
        />
      )}

      {renderState === 'ready' && currentRun && (
        <CanonicalAnswer
          takeaway={currentRun.summary.takeaway}
          comparison={currentRun.summary.comparison}
          trust={visualizationEvidenceTrust(currentRun.spec.trust.status)}
          eventCount={currentRun.eventCount}
          env={env}
          purpose={currentRun.spec.purpose}
          followUp={currentRun.summary.followUp}
          followUpTask={followUpAgentTask(currentRun.spec, currentRun.summary)}
          saveState={saveState}
          officialSaveState={officialSaveAllowed ? officialSaveState : 'hidden'}
          saveVariant={funnelSurface ? 'outline' : 'default'}
          onSave={() => void saveAnswer()}
          onSaveOfficial={officialSaveAllowed ? () => void saveAnswer(true) : undefined}
          chart={<ManualVisualizationRenderer spec={currentRun.spec} result={currentRun.result} showEvidenceSummary={false} />}
          evidence={<>Aggregation: {currentRun.spec.evidence.aggregation}. Sample: {currentRun.spec.evidence.sampleSize ?? 'unavailable'}. Coverage: {currentRun.spec.evidence.coverage}. Comparison: {currentRun.spec.evidence.comparisonBasis}. Computed from {currentRun.spec.evidence.source} at {new Date(currentRun.spec.evidence.computedAt).toLocaleString()}.</>}
        />
      )}

      <details className="group rounded-panel border bg-card">
        <DisclosureSummary className="flex min-h-14 cursor-pointer items-center gap-3 px-4 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:px-5">
          {funnelSurface ? 'Edit funnel analysis' : 'Edit analysis'}
          <span className="ml-auto text-sm font-normal text-muted-foreground group-open:hidden">
            {funnelSurface ? 'Saved funnel and exact range' : 'Range, metric, view and breakdown'}
          </span>
        </DisclosureSummary>
        <div className="border-t p-4 sm:p-5">
        {!funnelSurface && <div className="flex flex-col gap-4 lg:flex-row lg:items-end">
          <div className="w-full lg:max-w-sm">
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
                <SelectContent className="max-w-sm">
                  {scenarioOptions.map((option) => (
                    <SelectItem
                      key={option.key}
                      value={option.key}
                      disabled={option.disabled}
                      className="min-h-11 py-2"
                    >
                      <span className="flex min-w-0 flex-1 items-center justify-between gap-3">
                        <span className="truncate">{option.label}</span>
                        {option.reason && <span className="shrink-0 text-sm text-muted-foreground">{option.reason}</span>}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Control>
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">{template.question}</div>
            <p className="mt-1 text-sm text-muted-foreground">{template.purpose}</p>
          </div>
        </div>}
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
          <div className="mt-5 flex flex-col gap-4 lg:flex-row lg:items-end">
            <div className="grid min-w-0 flex-1 gap-3 sm:grid-cols-2 xl:grid-cols-6">
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
                {isFunnel ? (
                  <div className="flex h-11 items-center rounded-control border bg-background px-3 text-sm">Previous period</div>
                ) : (
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
                )}
              </Control>
            </div>
            <Button variant="outline" className="h-11 w-full lg:w-auto" onClick={execute} disabled={running || !selectedKey}>
              {running ? <Loader2 className="size-4 animate-spin" /> : <ArrowRight className="size-4" />}
              Run typed query
            </Button>
          </div>
        )}
        </div>
      </details>
    </div>
  );
}

function followUpAgentTask(spec: VisualizationSpec, summary: StandardAnswerSummary): string {
  return `Investigate the next evidence-backed question for ${spec.title} without changing its definition.\n\nProject: ${spec.project}\nEnvironment: ${spec.env}\nExact UTC range: ${spec.range.from} to ${spec.range.to}\nCurrent takeaway: ${summary.takeaway}\nNext question: ${summary.followUp}\n\nUse registered metrics and trusted properties only. Keep the same scope, report sample and data-quality limits, and prepare a proposal for human review.`;
}

function savedAnswerInput(run: AnalysisRun, templateKey: string): CreateSavedAnswerInput {
  const { spec, summary, eventCount, result } = run;
  if (spec.source.kind !== 'metric' && spec.source.kind !== 'funnel') {
    throw new Error('Product answers require a metric or funnel source.');
  }
  const percentageValue = spec.kind === 'funnel' || spec.kind === 'retention_curve' || spec.kind === 'retention_matrix';
  const sourceRef = spec.source.kind === 'funnel'
    ? { kind: 'funnel' as const, key: spec.source.key, goal: spec.purpose }
    : { kind: 'metric' as const, key: spec.source.key, purpose: spec.purpose };
  const coverageMatch = /^(\d+(?:\.\d+)?)% registered$/.exec(spec.evidence.coverage);
  const coverage = coverageMatch ? Number(coverageMatch[1]) / 100 : null;
  const blockers = spec.trust.blockers.map((blocker) => ({ code: blocker.code, message: blocker.message }));
  const resultEvidence = queryEvidence(result);
  const primaryValue = summary.currentValue === null
    ? null
    : percentageValue ? summary.currentValue * 100 : summary.currentValue;
  const deltaValue = summary.delta === null
    ? null
    : percentageValue ? summary.delta * 100 : summary.delta;
  const query = spec.source.query;
  return {
    title: spec.title,
    description: spec.question,
    template_key: templateKey,
    schema_version: 1,
    visualization_spec: spec,
    answer: {
      state: savedAnswerState(run),
      headline: spec.title,
      takeaway: summary.takeaway,
      ...(primaryValue === null ? {} : {
        primary_value: {
          value: primaryValue,
          unit: percentageValue ? 'percent' as const : 'count' as const,
          formatted: formatSavedValue(primaryValue, percentageValue),
        },
      }),
      ...(deltaValue === null ? {} : {
        delta: {
          value: deltaValue,
          unit: percentageValue ? 'percentage_point' as const : 'count' as const,
          direction: deltaValue > 0 ? 'up' as const : deltaValue < 0 ? 'down' as const : 'flat' as const,
          comparison_label: summary.comparison,
        },
      }),
      why_it_matters: spec.purpose,
    },
    evidence: {
      state: spec.trust.status,
      as_of: spec.evidence.computedAt,
      freshness: resultEvidence?.freshness ?? 'unknown',
      source_refs: [sourceRef],
      aggregation: spec.evidence.aggregation,
      sample: { eligible: null, observed: spec.evidence.sampleSize ?? eventCount, coverage },
      warnings: spec.trust.status === 'unavailable'
        ? []
        : [...(resultEvidence?.warnings ?? []), ...blockers],
      unavailable_reasons: spec.trust.status === 'unavailable'
        ? [...(resultEvidence?.unavailable_reasons ?? []), ...blockers]
        : [],
      reproducible_query: query,
    },
  };
}

function formatSavedValue(value: number, percentage: boolean): string {
  const formatted = new Intl.NumberFormat(undefined, { maximumFractionDigits: percentage ? 1 : 2 }).format(value);
  return percentage ? `${formatted}%` : formatted;
}

function savedAnswerState(run: AnalysisRun): CreateSavedAnswerInput['answer']['state'] {
  const serverState = queryAnswerState(run.result);
  if (serverState === 'error' || serverState === 'not_configured' || serverState === 'stale') return serverState;
  if (run.spec.trust.status === 'unavailable' || serverState === 'unavailable') return 'unavailable';
  if (countResultPoints(run.result) === 0 || serverState === 'empty') return 'empty';
  if (run.spec.trust.status === 'partial' || run.spec.trust.status === 'blocked' || serverState === 'partial') return 'partial';
  return 'ready';
}

function queryEvidence(result: AnalysisQueryResult) {
  return (result.kind === 'trend' || result.kind === 'funnel') ? result.evidence : undefined;
}

function queryAnswerState(result: AnalysisQueryResult) {
  return (result.kind === 'trend' || result.kind === 'funnel') ? result.answer?.state : undefined;
}

function visualizationEvidenceTrust(status: VisualizationSpec['trust']['status']): EvidenceTrust {
  if (status === 'trusted' || status === 'partial' || status === 'blocked') return status;
  return 'unavailable';
}

function summarizeProductAnswer(
  title: string,
  result: AnalysisQueryResult,
  previousResult: AnalysisQueryResult | null,
  context: { metric?: Pick<Metric, 'type' | 'source'>; breakdown?: string },
): StandardAnswerSummary {
  if (result.kind !== 'funnel' || !result.summary) {
    return summarizeAnswer(title, result, previousResult, context);
  }
  const currentValue = result.summary.overall_conversion;
  const previousValue = result.summary.previous_overall_conversion;
  const delta = result.summary.delta_percentage_points === null
    ? null
    : result.summary.delta_percentage_points / 100;
  const deltaPercent = delta !== null && previousValue !== null && previousValue !== 0
    ? delta / Math.abs(previousValue)
    : null;
  const movement = result.summary.delta_percentage_points === null
    ? 'Previous-period comparison is unavailable.'
    : Math.abs(result.summary.delta_percentage_points) < 0.05
      ? 'It is stable versus the previous exact period.'
      : `${result.summary.delta_percentage_points > 0 ? 'Up' : 'Down'} ${Math.abs(result.summary.delta_percentage_points).toLocaleString()} percentage points versus the previous exact period.`;
  return {
    takeaway: currentValue === null
      ? `${title} is rendered, but the server summary has no conversion denominator.`
      : `${title} is ${percent(currentValue)}. ${movement}`,
    currentValue,
    previousValue,
    delta,
    deltaPercent,
    comparison: previousValue === null ? 'No safely comparable period headline' : 'Previous exact period',
    followUp: deltaPercent !== null && Math.abs(deltaPercent) >= 0.1
      ? 'Break this movement down by one trusted property.'
      : 'Extend the range or inspect the funnel definition before acting.',
  };
}

export interface FunnelLossSummary {
  kind: 'absolute' | 'percentage';
  fromLabel: string;
  toLabel: string;
  fromMetric: string;
  toMetric: string;
  lostActors: number;
  dropRate: number | null;
  overallConversion: number | null;
  previousOverallConversion: number | null;
  deltaPercentagePoints: number | null;
}

export function selectServerFunnelLoss(
  result: FunnelQueryResult,
  requested?: RequestedFunnelTransition | null,
): FunnelLossSummary | null {
  const serverSummary = result.summary;
  if (!serverSummary) return null;
  const candidates = [
    { kind: 'absolute' as const, loss: serverSummary.biggest_absolute_loss },
    { kind: 'percentage' as const, loss: serverSummary.biggest_percentage_loss },
  ];
  const selected = requested
    ? candidates.find(({ loss }) => loss?.from_step === requested.fromStep && loss.to_step === requested.toStep)
    : candidates.find(({ loss }) => loss !== null);
  if (!selected?.loss) return null;
  const from = result.steps[selected.loss.from_step];
  const to = result.steps[selected.loss.to_step];
  if (!from || !to) return null;
  return {
    kind: selected.kind,
    fromLabel: from.label,
    toLabel: to.label,
    fromMetric: from.metric_key,
    toMetric: to.metric_key,
    lostActors: selected.loss.lost_actors,
    dropRate: selected.loss.drop_rate,
    overallConversion: serverSummary.overall_conversion,
    previousOverallConversion: serverSummary.previous_overall_conversion,
    deltaPercentagePoints: serverSummary.delta_percentage_points,
  };
}

function FunnelBiggestLoss({
  funnel,
  result,
  requestedTransition,
  relatedEvidence,
  relatedEvidenceUnavailable,
  env,
}: {
  funnel: Funnel | null;
  result: FunnelQueryResult;
  requestedTransition: RequestedFunnelTransition | null;
  relatedEvidence: RelatedFunnelEvidence;
  relatedEvidenceUnavailable: boolean;
  env: string;
}) {
  const { client, project } = useStore();
  const [taskVisible, setTaskVisible] = useState(false);
  const [copied, setCopied] = useState(false);
  const [proposalState, setProposalState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [proposalDecisionId, setProposalDecisionId] = useState<string | null>(null);
  useEffect(() => {
    setProposalState('idle');
    setProposalDecisionId(null);
  }, [env, funnel?.key, result.meta.computed_at]);
  const summary = selectServerFunnelLoss(result, requestedTransition);
  if (!funnel) return null;
  if (!summary) {
    return (
      <AnswerCanvas>
        <div className="p-4 sm:p-5">
          <div className="text-sm font-medium text-muted-foreground">Biggest loss</div>
          <h2 className="mt-1 text-xl font-semibold">Requested transition is unavailable</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            The server summary does not contain this transition. Open the funnel without step parameters or rerun it after checking the saved definition.
          </p>
        </div>
      </AnswerCanvas>
    );
  }
  if (summary.lostActors === 0) {
    return <AnswerCanvas><div className="p-4 sm:p-5"><div className="text-sm font-medium text-muted-foreground">Biggest loss</div><h2 className="mt-1 text-xl font-semibold">No measured loss in this period</h2><p className="mt-2 text-sm text-muted-foreground">Every measured actor reached each saved funnel step. No loss or investigate action is implied.</p></div></AnswerCanvas>;
  }
  const compatible = selectCompatibleFunnelEvidence(result, summary.toMetric, relatedEvidence, env);
  const proposalRelease = compatible.releases.find((release) => release.status === 'deployed' || release.status === 'observing') ?? null;
  const absoluteLabel = funnelLossLabel(result, result.summary?.biggest_absolute_loss ?? null);
  const percentageLabel = funnelLossLabel(result, result.summary?.biggest_percentage_loss ?? null);
  const task = `Investigate the biggest measured loss in funnel ${funnel.key} without changing its definition.\n\nGoal: ${funnel.goal}\nEnvironment and exact period are in the attached Poolstatis query.\nTransition: ${summary.fromLabel} (${summary.fromMetric}) -> ${summary.toLabel} (${summary.toMetric})\nCurrent loss: ${summary.lostActors} actors${summary.dropRate === null ? '' : ` (${percent(summary.dropRate)})`}\n\nUse registered metrics and trusted properties only. Compare safe breakdowns, report sample and data-quality limits, and prepare an evidence-backed proposal for human review.`;
  const copyTask = async () => {
    try {
      await navigator.clipboard.writeText(task);
      setCopied(true);
    } catch {
      setTaskVisible(true);
    }
  };
  const saveProposal = async () => {
    if (!proposalRelease || !client || !project || proposalState === 'saving' || proposalState === 'saved') return;
    setProposalState('saving');
    try {
      const saved = await client.evaluateRelease(project, proposalRelease.id);
      setProposalDecisionId(saved.decision.id);
      setProposalState('saved');
    } catch {
      setProposalState('error');
    }
  };
  return (
    <AnswerCanvas>
      <div className="grid gap-4 p-4 sm:p-5 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
        <div className="min-w-0">
          <div className="text-sm font-medium text-muted-foreground">Biggest loss</div>
          <h2 className="mt-1 text-xl font-semibold">{summary.fromLabel} → {summary.toLabel}</h2>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            {fmtActors(summary.lostActors)} lost · {summary.dropRate === null ? 'drop rate unavailable' : `${percent(summary.dropRate)} drop`}
            {summary.deltaPercentagePoints === null ? ' · previous-period comparison unavailable' : ` · overall ${signedPercentagePoints(summary.deltaPercentagePoints)} vs previous exact period`}.
          </p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
            <FunnelFact label="Overall conversion" value={summary.overallConversion === null ? 'Unavailable' : percent(summary.overallConversion)} />
            <FunnelFact label="Previous conversion" value={summary.previousOverallConversion === null ? 'Unavailable' : percent(summary.previousOverallConversion)} />
            <FunnelTransitionFact label="Biggest absolute" value={absoluteLabel} />
            <FunnelTransitionFact label="Biggest percentage" value={percentageLabel} />
            <FunnelFact label="Affected goal" value={funnel.goal} />
          </div>
        </div>
        <Button className="h-11 w-full lg:w-auto" onClick={() => void copyTask()}>{copied ? 'Investigation copied' : `Investigate ${summary.fromLabel} → ${summary.toLabel}`}</Button>
      </div>
      {result.evidence?.warnings.length ? (
        <div className="border-t px-4 py-3 text-sm sm:px-5">
          <div className="font-medium">Evidence notes</div>
          {result.evidence.warnings.map((warning) => <p key={`${warning.code}:${warning.message}`} className="mt-1 text-muted-foreground">{warning.message}</p>)}
        </div>
      ) : null}
      <div className="border-t px-4 py-4 text-sm sm:px-5">
        <div className="font-medium">Related change evidence</div>
        {compatible.releases.length === 0 && compatible.experiments.length === 0 ? (
          <p className="mt-1 text-muted-foreground">
            {relatedEvidenceUnavailable
              ? 'Release and experiment evidence could not be read.'
              : 'No compatible release or experiment overlaps this environment, metric and exact period.'}
          </p>
        ) : (
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2">
            {compatible.releases.map((release) => (
              <Link key={release.id} className="font-medium text-foreground underline decoration-muted-foreground/50 underline-offset-4 hover:decoration-foreground" to="/changes">
                Release {release.commit_sha.slice(0, 10)}
              </Link>
            ))}
            {compatible.experiments.map((experiment) => (
              <Link key={experiment.id} className="font-medium text-foreground underline decoration-muted-foreground/50 underline-offset-4 hover:decoration-foreground" to="/experiments">
                Experiment {experiment.name}
              </Link>
            ))}
          </div>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-3">
          {proposalDecisionId ? (
            <Button asChild variant="outline"><Link to={`/decisions?decision=${encodeURIComponent(proposalDecisionId)}`}>Open proposal in Decisions</Link></Button>
          ) : proposalRelease ? (
            <Button type="button" variant="outline" onClick={() => void saveProposal()} disabled={proposalState === 'saving'}>
              {proposalState === 'saving' ? <Loader2 className="size-4 animate-spin" /> : null}
              {proposalState === 'saving' ? 'Evaluating release…' : 'Evaluate linked release for proposal'}
            </Button>
          ) : (
            <p className="text-muted-foreground">Link a compatible registered release before creating a Decisions proposal.</p>
          )}
          <Link className="font-medium text-foreground underline decoration-muted-foreground/50 underline-offset-4 hover:decoration-foreground" to="/changes">Continue through Ship</Link>
        </div>
        {proposalRelease && !proposalDecisionId ? (
          <p className="mt-2 text-muted-foreground">
            The proposal comes only from the linked release&apos;s frozen contract and server evaluation. Copying the investigation task is not treated as evidence or causal proof.
          </p>
        ) : null}
        {proposalState === 'error' && <p role="alert" className="mt-2 text-destructive">The release evidence could not be evaluated. Review its frozen contract and try again.</p>}
      </div>
      {taskVisible && (
        <div className="border-t p-4 sm:p-5">
          <p role="alert" className="mb-2 text-sm text-muted-foreground">Clipboard access was blocked. Copy the prepared task manually.</p>
          <pre tabIndex={0} className="max-h-72 overflow-auto whitespace-pre-wrap rounded-panel border bg-background p-4 text-sm">{task}</pre>
        </div>
      )}
    </AnswerCanvas>
  );
}

function FunnelFact({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0 rounded-control border bg-muted/20 p-3"><div className="text-sm text-muted-foreground">{label}</div><div className="mt-1 break-words font-medium">{value}</div></div>;
}

function FunnelTransitionFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-control border bg-muted/20 p-3">
      <div className="text-sm text-muted-foreground">{label}<span className="sr-only"> {value}</span></div>
      <div aria-hidden="true" className="mt-1 break-words font-medium">{value}</div>
    </div>
  );
}

function percent(value: number) {
  return `${Math.round(value * 1_000) / 10}%`;
}

function signedPercentagePoints(value: number) {
  const points = Math.round(value * 10) / 10;
  return `${points > 0 ? '+' : ''}${points} pp`;
}

function fmtActors(value: number) {
  return `${value.toLocaleString()} ${value === 1 ? 'actor' : 'actors'}`;
}

function requestedFunnelTransition(from: string | null, to: string | null): RequestedFunnelTransition | null {
  if (from === null && to === null) return null;
  if (!/^\d+$/.test(from ?? '') || !/^\d+$/.test(to ?? '')) return null;
  const fromStep = Number(from);
  const toStep = Number(to);
  return toStep === fromStep + 1 ? { fromStep, toStep } : null;
}

function funnelLossLabel(result: FunnelQueryResult, loss: NonNullable<FunnelQueryResult['summary']>['biggest_absolute_loss']): string {
  if (!loss) return 'Unavailable';
  const from = result.steps[loss.from_step];
  const to = result.steps[loss.to_step];
  return from && to ? `${from.label} → ${to.label}` : 'Unavailable';
}

export function selectCompatibleFunnelEvidence(
  result: FunnelQueryResult,
  metricKey: string,
  evidence: RelatedFunnelEvidence,
  env: string,
): RelatedFunnelEvidence {
  const from = Date.parse(result.meta.date_range.from);
  const to = Date.parse(result.meta.date_range.to);
  const releases = evidence.releases.filter((release) => {
    const deployedAt = Date.parse(release.deployed_at ?? '');
    return release.env === env
      && ['deployed', 'observing', 'decided'].includes(release.status)
      && release.contract_snapshot.primary_metric_key === metricKey
      && Number.isFinite(deployedAt)
      && deployedAt >= from
      && deployedAt <= to;
  });
  const experiments = evidence.experiments.filter((experiment) => {
    const startedAt = Date.parse(experiment.started_at ?? '');
    const concludedAt = experiment.concluded_at ? Date.parse(experiment.concluded_at) : Number.POSITIVE_INFINITY;
    return experiment.env === env
      && ['running', 'concluded'].includes(experiment.status)
      && experiment.primary_metric_key === metricKey
      && Number.isFinite(startedAt)
      && startedAt <= to
      && concludedAt >= from;
  });
  return { releases, experiments };
}

function Control({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="grid min-w-0 gap-1.5 text-sm font-medium text-muted-foreground">{label}{children}</label>;
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
  comparisonAvailable: boolean;
}): VisualizationSpec {
  const source = input.query.kind === 'funnel'
    ? { kind: 'funnel' as const, key: input.funnel?.key ?? input.query.funnel ?? 'inline', query: input.query }
    : { kind: 'metric' as const, key: metricKey(input.query), query: input.query };
  const purpose = input.funnel?.goal ?? input.metric?.purpose ?? input.template.purpose;
  const trust = evidenceBoundTrust(input.trust.trust, queryEvidence(input.result));
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
    trust,
    evidence: {
      aggregation: aggregationLabel(input.query, input.metric, input.funnel),
      denominator: denominatorLabel(input.result),
      sampleSize: sampleSize(input.result, input.trust),
      coverage: input.trust.coverage,
      source: input.result.meta.source,
      computedAt: input.result.meta.computed_at,
      comparisonBasis: input.comparisonAvailable ? 'Previous exact period of equal duration.' : 'Previous-period comparison is unavailable.',
    },
    display: {
      valueFormat: input.query.kind === 'retention' || input.query.kind === 'funnel' ? 'percent' : 'number',
      granularity: 'interval' in input.query ? input.query.interval : undefined,
      compare: input.comparisonAvailable ? 'previous_period' : 'none',
      series: seriesFor(input.result, input.metric),
    },
    actions: [
      { kind: 'open_query', query: input.query },
      ...(source.kind === 'funnel' ? [{ kind: 'open_funnel' as const, key: source.key }] : [{ kind: 'open_metric' as const, key: source.key }]),
      { kind: 'save_view' },
    ],
  };
  return spec;
}

function evidenceBoundTrust(
  trust: VisualizationSpec['trust'],
  evidence: ReturnType<typeof queryEvidence>,
): VisualizationSpec['trust'] {
  if (!evidence) return trust;
  const rank = { trusted: 0, partial: 1, blocked: 2, unavailable: 3 } as const;
  if (rank[evidence.state] <= rank[trust.status]) return trust;
  const evidenceReason = evidence.unavailable_reasons[0]?.message
    ?? evidence.warnings[0]?.message
    ?? `The query returned ${evidence.state} evidence.`;
  return { ...trust, status: evidence.state, reason: evidenceReason };
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
