import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ArrowRight } from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { EmptyState, ErrorNote, HelpDisclosure, KpiRail, Loading, PageHeading, Panel, fmtNum } from '@/components/ui';
import { AnswerCanvas, type EvidenceTrust } from '@/components/analytics';
import { AnalyticsDateRange } from '@/components/AnalyticsDateRange';
import { TrendChart } from '../analysis/charts';
import {
  WEB_PAGE_VIEW_METRIC,
  engagementLabel,
  formatDurationMs,
  formatPercent,
  webPageMetric,
  type WebAnalyticsResult,
  type WebDimension,
  type WebSessionResult,
  type WebSessionSummary,
  type WebSessionsResult,
  type WebWorkspaceResult,
} from '../analysis/operations';
import { previousAnalyticsRange, type AnalyticsRangeSelection, type ResolvedAnalyticsRange } from '../analysis/ranges';
import { useAnalyticsRange } from '../analysis/useAnalyticsRange';
import { analyticsNavigationTarget } from '../analysis/navigation';
import type { FunnelQueryResult, TrendQueryResult } from '../analysis/visualization';
import type { MeasurementTrust, Metric, PropertyDefinition } from '../api/types';
import { useAsync, useStore } from '../store';
import { AcquisitionPanel } from './Measurement';

type BreakdownView = WebDimension | 'conversion';
const DIMENSIONS: Array<{ value: BreakdownView; label: string }> = [
  { value: 'source', label: 'Sources' },
  { value: 'medium', label: 'Medium' },
  { value: 'route', label: 'Pages' },
  { value: 'campaign', label: 'Campaigns' },
  { value: 'term', label: 'UTM term' },
  { value: 'content', label: 'UTM content' },
  { value: 'conversion', label: 'Conversions' },
  { value: 'country', label: 'Countries' },
  { value: 'device', label: 'Devices' },
];

interface WebRegistryRead {
  scope: string;
  metric: Metric | null;
  proposedMetric: Metric | null;
  properties: PropertyDefinition[];
  metrics: Metric[];
}

interface WebPrimaryRead {
  scope: string;
  metric: Metric;
  overview: WebAnalyticsResult;
}

interface WebComparisonRead {
  scope: string;
  result: WebAnalyticsResult;
}

interface WebTrendRead {
  scope: string;
  result: WebWorkspaceResult['trend'];
}

interface WebOutcomeRead {
  scope: string;
  metric: Metric;
  result: TrendQueryResult;
}

interface WebOutcomeComparisonRead {
  scope: string;
  result: TrendQueryResult;
}

interface WebTrustScopedRead {
  scope: string;
  result: WebTrustRead;
}

interface WebSecondaryRead {
  scope: string;
  dimension: WebDimension;
  result: WebAnalyticsResult;
}

interface WebConversionRead {
  scope: string;
  metric: Metric;
  result: FunnelQueryResult;
}

interface WebSessionsRead {
  scope: string;
  result: WebSessionsResult;
}

const UTM_PROPERTY_KEYS = ['$utm_source', '$utm_medium', '$utm_campaign', '$utm_term', '$utm_content'] as const;
const BROWSER_PROPERTY_KEYS = [
  '$browser_context', '$route_key', '$page_view_id', '$device_class', '$browser_family',
  '$os_family', '$language', '$timezone', '$viewport_bucket', '$screen_bucket', '$country',
] as const;

type WebDefinitionRepairState =
  | { kind: 'ready' }
  | { kind: 'review' }
  | { kind: 'missing_route' }
  | { kind: 'missing_browser'; routeKeys: string[] }
  | { kind: 'missing_utm' };

export function webDefinitionRepairState(properties: PropertyDefinition[]): WebDefinitionRepairState {
  const definitions = new Map(
    properties.filter((property) => property.scope === 'event').map((property) => [property.key, property]),
  );
  const reserved = [...BROWSER_PROPERTY_KEYS, ...UTM_PROPERTY_KEYS]
    .map((key) => definitions.get(key))
    .filter((property): property is PropertyDefinition => Boolean(property));
  if (reserved.some((property) => property.status !== 'trusted')) return { kind: 'review' };
  const route = definitions.get('$route_key');
  if (!route) return { kind: 'missing_route' };
  if (BROWSER_PROPERTY_KEYS.some((key) => !definitions.has(key))) {
    const routeKeys = route.enum_values ?? [];
    return routeKeys.length > 0 ? { kind: 'missing_browser', routeKeys } : { kind: 'review' };
  }
  if (UTM_PROPERTY_KEYS.some((key) => !definitions.has(key))) return { kind: 'missing_utm' };
  return { kind: 'ready' };
}

const webRouteKeyPattern = /^[a-z][a-z0-9_.:-]{0,99}$/;

export function parseWebRouteKeys(value: string): string[] {
  const routeKeys = [...new Set(value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean))].sort();
  if (routeKeys.length === 0) throw new Error('Add at least one safe route key.');
  if (routeKeys.length > 100) throw new Error('Use at most 100 safe route keys.');
  const invalid = routeKeys.find((routeKey) => !webRouteKeyPattern.test(routeKey));
  if (invalid) throw new Error(`Invalid route key: ${invalid}`);
  return routeKeys;
}

export function WebAnalytics() {
  const location = useLocation();
  const { client, project, env } = useStore();
  const { selection: rangeSelection, resolved: range, setSelection: setRangeSelection } = useAnalyticsRange();
  const [dimension, setDimension] = useState<BreakdownView>('source');
  const [selectedSession, setSelectedSession] = useState<{ scope: string; session: WebSessionSummary } | null>(null);
  const [sessionsRequested, setSessionsRequested] = useState(false);
  const registryScope = `${project ?? ''}\u0000${env}`;
  const registry = useAsync<WebRegistryRead>(async () => {
    const [metrics, properties] = await Promise.all([
      client!.metrics(project!),
      client!.properties(project!, { scope: 'event' }),
    ]);
    return {
      scope: registryScope,
      metric: webPageMetric(metrics),
      proposedMetric: metrics.find((item) => item.key === WEB_PAGE_VIEW_METRIC && item.status === 'proposed') ?? null,
      properties,
      metrics,
    };
  }, [project, env]);
  const registryData = registry.data?.scope === registryScope ? registry.data : null;
  const metric = registryData?.metric ?? null;
  const outcomeMetric = registryData ? webOutcomeMetric(registryData.metrics) : null;
  const conversionMetric = webConversionMetric(registryData?.metrics ?? []);
  const primaryScope = `${registryScope}\u0000${range.from}\u0000${range.to}\u0000${metric?.key ?? ''}`;
  const outcomeScope = `${registryScope}\u0000${range.from}\u0000${range.to}\u0000${outcomeMetric?.key ?? ''}`;
  const primary = useAsync<WebPrimaryRead | null>(async () => {
    if (!metric) return null;
    const base = {
      metric: metric.key,
      date_from: range.from,
      date_to: range.to,
      filters: [],
      env,
    };
    const overview = await client!.operationalQuery<WebAnalyticsResult>(project!, {
      kind: 'web_analytics',
      ...base,
      dimensions: [],
    });
    return { scope: primaryScope, metric, overview };
  }, [project, env, range.from, range.to, metric?.key], { keepPreviousData: true });
  const exactPrimaryData = primary.data?.scope === primaryScope ? primary.data : null;
  const primaryData = exactPrimaryData ?? (
    primary.loading
      && primary.data !== null
      && primary.data?.metric.key === metric?.key
      && primary.data.scope.startsWith(`${registryScope}\u0000`)
      ? primary.data
      : null
  );
  const primaryRefreshing = primary.loading && !exactPrimaryData && Boolean(primaryData);
  const comparison = useAsync<WebComparisonRead | null>(async () => {
    if (!metric || !primaryData) return null;
    const previous = previousAnalyticsRange(range);
    const result = await client!.operationalQuery<WebAnalyticsResult>(project!, {
      kind: 'web_analytics', metric: metric.key, date_from: previous.from, date_to: previous.to,
      filters: [], env, dimensions: [],
    });
    return { scope: primaryScope, result };
  }, [project, env, range.from, range.to, metric?.key, primaryData?.overview.meta.computed_at]);
  const comparisonData = comparison.data?.scope === primaryScope ? comparison.data.result : null;
  const trendRead = useAsync<WebTrendRead | null>(async () => {
    if (!metric || !primaryData) return null;
    const result = await client!.query(project!, {
      kind: 'trend', metric: metric.key, date_from: range.from, date_to: range.to,
      interval: 'day', filters: [], env,
    });
    if (result.kind !== 'trend') throw new Error('Trend query returned an unexpected result kind');
    return { scope: primaryScope, result };
  }, [project, env, range.from, range.to, metric?.key, primaryData?.overview.meta.computed_at], { keepPreviousData: true });
  const trendData = trendRead.data?.scope === primaryScope
    ? trendRead.data.result
    : trendRead.loading && trendRead.data?.scope.startsWith(`${registryScope}\u0000`)
      ? trendRead.data.result
      : null;
  const trustRead = useAsync<WebTrustScopedRead | null>(async () => {
    if (!metric || !primaryData) return null;
    return { scope: primaryScope, result: await readWebTrust(client!, project!, env, metric.key, range.days) };
  }, [project, env, range.from, range.to, metric?.key, primaryData?.overview.meta.computed_at]);
  const trustData = trustRead.data?.scope === primaryScope ? trustRead.data.result : null;
  const outcomeRead = useAsync<WebOutcomeRead | null>(async () => {
    if (!outcomeMetric || outcomeMetric.type === 'conversion') return null;
    const result = await client!.query(project!, {
      kind: 'trend', metric: outcomeMetric.key, date_from: range.from, date_to: range.to,
      interval: 'day', filters: [], env,
    });
    if (result.kind !== 'trend') throw new Error('Outcome query returned an unexpected result kind');
    return { scope: outcomeScope, metric: outcomeMetric, result };
  }, [project, env, range.from, range.to, outcomeMetric?.key, outcomeMetric?.type]);
  const outcomeData = outcomeRead.data?.scope === outcomeScope ? outcomeRead.data : null;
  const outcomeComparison = useAsync<WebOutcomeComparisonRead | null>(async () => {
    if (!outcomeMetric || !outcomeData) return null;
    const previousRange = previousExactRange(outcomeData.result.meta.date_range);
    if (!previousRange) throw new Error('Outcome comparison range is unavailable');
    const result = await client!.query(project!, {
      kind: 'trend', metric: outcomeMetric.key,
      date_from: previousRange.from, date_to: previousRange.to,
      interval: 'day', filters: [], env,
    });
    if (result.kind !== 'trend') throw new Error('Outcome comparison returned an unexpected result kind');
    return { scope: outcomeScope, result };
  }, [
    project, env, range.from, range.to, outcomeMetric?.key, outcomeData?.result.meta.computed_at,
    outcomeData?.result.meta.date_range?.from, outcomeData?.result.meta.date_range?.to,
  ]);
  const outcomeComparisonData = outcomeComparison.data?.scope === outcomeScope
    ? outcomeComparison.data.result
    : null;
  const operationalDimension = dimension !== 'conversion' ? dimension : null;
  const secondary = useAsync<WebSecondaryRead | null>(async () => {
    if (!metric || !primaryData || !operationalDimension) return null;
    const result = await client!.operationalQuery<WebAnalyticsResult>(project!, {
      kind: 'web_analytics',
      metric: metric.key,
      date_from: range.from,
      date_to: range.to,
      filters: [],
      env,
      dimensions: [operationalDimension],
    });
    return { scope: primaryScope, dimension: operationalDimension, result };
  }, [project, env, range.from, range.to, metric?.key, primaryData?.overview.meta.computed_at, operationalDimension]);
  const secondaryData = secondary.data?.scope === primaryScope
    && secondary.data.dimension === operationalDimension ? secondary.data.result : null;
  const conversionFrom = primaryData?.overview.meta.date_range.from ?? '';
  const conversionTo = primaryData?.overview.meta.date_range.to ?? '';
  const conversionScope = `${primaryScope}\u0000${conversionMetric?.key ?? ''}\u0000${conversionFrom}\u0000${conversionTo}`;
  const conversion = useAsync<WebConversionRead | null>(async () => {
    if (!primaryData || dimension !== 'conversion' || !conversionMetric) return null;
    const result = await client!.query(project!, {
      kind: 'funnel',
      conversion_metric: conversionMetric.key,
      date_from: primaryData.overview.meta.date_range.from,
      date_to: primaryData.overview.meta.date_range.to,
      env,
    });
    if (result.kind !== 'funnel') throw new Error('Conversion query returned an unexpected result kind');
    return { scope: conversionScope, metric: conversionMetric, result };
  }, [project, env, dimension, conversionMetric?.key, conversionScope, conversionFrom, conversionTo]);
  const conversionData = conversion.data?.scope === conversionScope ? conversion.data : null;
  const sessions = useAsync<WebSessionsRead | null>(async () => {
    if (!metric || !primaryData || !sessionsRequested) return null;
    const result = await client!.operationalQuery<WebSessionsResult>(project!, {
      kind: 'web_sessions', metric: metric.key, date_from: range.from, date_to: range.to, filters: [], env, limit: 50,
    });
    return { scope: primaryScope, result };
  }, [project, env, range.from, range.to, metric?.key, primaryData?.overview.meta.computed_at, sessionsRequested]);
  const sessionsData = sessions.data?.scope === primaryScope ? sessions.data.result : null;
  const currentSession = selectedSession?.scope === primaryScope ? selectedSession.session : null;

  useEffect(() => {
    setSelectedSession(null);
    setSessionsRequested(false);
  }, [project, env, range.from, range.to]);

  if (registry.loading || (!registryData && !registry.error)) return <WebAnalyticsSkeleton />;
  if (registry.error) return <ErrorNote>{registry.error}</ErrorNote>;
  if (!registryData) return null;
  if (!metric) {
    const setupData = registryData;
    return (
      <div className="space-y-5">
        <ScreenHeader />
        <WebSetup metric={setupData.proposedMetric} onReady={registry.reload} />
      </div>
    );
  }
  if (primary.loading && !primaryData) return <WebAnalyticsSkeleton />;
  if (!primaryData && !primary.error) return <WebAnalyticsSkeleton />;
  if (primary.error) return <ErrorNote>{primary.error}</ErrorNote>;
  if (!primaryData) return null;

  const { overview } = primaryData;
  const { properties, metrics } = registryData;
  const trust = trustData ?? { result: null, unavailable: true };
  const breakdownResponse = secondaryData;
  const breakdown = operationalDimension ? breakdownResponse?.breakdowns[operationalDimension] ?? [] : [];
  const unavailableDimensions = breakdownResponse?.meta.unavailable_dimensions ?? {};
  const unavailable = operationalDimension ? unavailableDimensions[operationalDimension] : null;
  const routeAvailable = routeDefinitionsReady(properties);
  const repairState = webDefinitionRepairState(properties);
  const acquisitionTrusted = UTM_PROPERTY_KEYS.every((key) => properties.some(
    (property) => property.key === key && property.scope === 'event' && property.status === 'trusted',
  ));
  const canonicalReady = hasAcceptedCanonicalPageViews(overview.summary.page_views);
  const outcomeReady = hasWebOutcome(metrics);

  return (
    <div className="space-y-5">
      <ScreenHeader />

      <WebTrafficOverview
        overview={overview}
        trend={trendData}
        trendError={trendRead.error}
        onRetryTrend={trendRead.reload}
        trust={trust}
        env={env}
        metric={metric}
        range={range}
        selection={rangeSelection}
        onRange={(value) => { setRangeSelection(value); setSelectedSession(null); }}
        refreshing={primaryRefreshing}
      />

      {repairState.kind !== 'ready' && <WebRepair state={repairState} />}
      {repairState.kind === 'ready' && !outcomeReady && <WebOutcomeSetup />}

      {(canonicalReady && acquisitionTrusted && outcomeReady) || outcomeMetric ? (
        <div className="grid gap-4 xl:grid-cols-2">
          {canonicalReady && acquisitionTrusted && outcomeReady && (
            <WebHealthAnswer
              current={overview}
              previous={comparisonData}
              comparisonState={comparisonData ? 'ready' : comparison.error ? 'unavailable' : 'loading'}
              range={range}
              trust={trust}
              trustLoading={!trustData && !trustRead.error}
              env={env}
            />
          )}
          {outcomeMetric && (
            <WebOutcomeAnswer
              metric={outcomeMetric}
              current={outcomeData?.result ?? null}
              currentState={outcomeMetric.type === 'conversion'
                ? 'unsupported'
                : outcomeRead.error
                  ? 'unavailable'
                  : outcomeData
                    ? 'ready'
                    : 'loading'}
              currentError={outcomeRead.error}
              previous={outcomeComparisonData}
              comparisonState={outcomeComparisonData
                ? 'ready'
                : outcomeComparison.error
                  ? 'unavailable'
                  : outcomeData
                    ? 'loading'
                    : 'unavailable'}
              range={range}
              env={env}
              onRetry={outcomeRead.reload}
            />
          )}
        </div>
      ) : null}

      <AnswerCanvas>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3 sm:px-5">
          <h2 className="text-sm font-semibold">Traffic breakdown</h2>
          {!breakdownResponse && operationalDimension !== null
            ? <Badge variant="outline">Loading selected view</Badge>
            : breakdownResponse && breakdownResponse.meta.truncated_dimensions.length > 0
            ? <Badge variant="outline">Top values · truncated</Badge>
            : Object.keys(unavailableDimensions).length > 0
              ? <Badge variant="outline">Partial response</Badge>
              : <Badge variant="outline">Complete response</Badge>}
        </div>
        <div className="p-4 sm:p-5">
        <div className="mb-4 max-w-full overflow-x-auto">
          <Tabs value={dimension} onValueChange={(value) => setDimension(value as BreakdownView)}>
            <TabsList className="w-max">
              {DIMENSIONS.map((item) => <TabsTrigger key={item.value} value={item.value}>{item.label}</TabsTrigger>)}
            </TabsList>
          </Tabs>
        </div>
        {dimension === 'conversion' && conversionMetric ? (
          <WebConversionAnswer
            metric={conversionMetric}
            result={conversionData?.result ?? null}
            loading={conversion.loading || (!conversionData && !conversion.error)}
            error={conversion.error}
            onRetry={conversion.reload}
          />
        ) : dimension === 'conversion' ? (
          <div className="border-y border-dashed px-4 py-7 text-center">
            <div className="text-lg font-semibold">{outcomeMetric ? outcomeMetric.name : 'Choose a conversion to measure'}</div>
            <p className="mx-auto mt-1 max-w-lg text-sm text-muted-foreground">
              {outcomeMetric
                ? `The registered ${outcomeMetric.key} outcome is measured above for this exact period; this tab does not reinterpret traffic as conversion.`
                : 'No active non-page-view metric is mapped to surface:web, so Poolstatis will not display a zero.'}
            </p>
            <Button asChild variant="outline" className="mt-4 h-11"><Link to={outcomeMetric ? '/analyze' : '/registry'}>{outcomeMetric ? 'Analyze outcome' : 'Review outcomes'}</Link></Button>
          </div>
        ) : secondary.loading ? (
          <Loading what={`Loading ${DIMENSIONS.find((item) => item.value === dimension)?.label ?? dimension} breakdown…`} />
        ) : secondary.error ? (
          <div><ErrorNote>{secondary.error}</ErrorNote><Button variant="outline" className="mt-3 h-11" onClick={secondary.reload}>Retry breakdown</Button></div>
        ) : unavailable ? (
          <UnavailableDimension label={DIMENSIONS.find((item) => item.value === dimension)?.label ?? dimension} unavailable={unavailable} />
        ) : breakdown.length === 0 ? (
          <EmptyState headline="No breakdown values" lead="No canonical page views matched this period." />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{DIMENSIONS.find((item) => item.value === dimension)?.label}</TableHead>
                  <TableHead className="text-right">Visitors</TableHead>
                  <TableHead className="text-right">Sessions</TableHead>
                  <TableHead className="text-right">Views</TableHead>
                  <TableHead className="text-right">Share</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {breakdown.map((row) => (
                  <TableRow key={row.value}>
                    <TableCell className="font-mono text-xs">{row.value}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtNum(row.visitors)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtNum(row.sessions)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtNum(row.page_views)}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.percentage === null ? 'Unavailable' : `${row.percentage.toFixed(1)}%`}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        </div>
      </AnswerCanvas>

      <Panel
        title="Recent sessions"
        right={sessionsData ? <span className="text-sm text-muted-foreground">{sessionsData.sessions.length} of {sessionsData.meta.total}</span> : undefined}
      >
        {!sessionsRequested ? (
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="max-w-2xl text-sm text-muted-foreground">Session rows are a secondary read and do not block the Web health answer.</p>
            <Button variant="outline" className="h-11 shrink-0" onClick={() => setSessionsRequested(true)}>Load recent sessions</Button>
          </div>
        ) : sessions.loading || (!sessionsData && !sessions.error) ? (
          <Loading what="Loading recent sessions…" />
        ) : sessions.error ? (
          <div><ErrorNote>{sessions.error}</ErrorNote><Button variant="outline" className="mt-3 h-11" onClick={sessions.reload}>Retry sessions</Button></div>
        ) : sessionsData?.sessions.length === 0 ? (
          <EmptyState headline="No sessions" lead="No canonical browser sessions matched this period." />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Actor</TableHead>
                  <TableHead>Started</TableHead>
                  <TableHead className="text-right">Pages</TableHead>
                  <TableHead className="text-right">Foreground</TableHead>
                  <TableHead>Engagement</TableHead>
                  <TableHead><span className="sr-only">Open</span></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sessionsData!.sessions.map((session) => (
                  <TableRow key={`${session.actor_id}:${session.session_id}`}>
                    <TableCell>
                      <Link
                        to={analyticsNavigationTarget(`/analyze/users/${encodeURIComponent(session.actor_id)}`, location.search)}
                        className="inline-flex max-w-full break-all rounded-control px-1 py-0.5 font-mono text-xs text-foreground underline-offset-4 hover:bg-muted hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {session.actor_id}
                      </Link>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                      {formatDateTime(session.started_at)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{session.page_views}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatDurationMs(session.foreground_ms)}</TableCell>
                    <TableCell><SessionState session={session} /></TableCell>
                    <TableCell className="text-right">
                      {routeAvailable ? (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className="size-11 md:size-8"
                          aria-label={`Open session ${session.session_id}`}
                          onClick={() => setSelectedSession({ scope: primaryScope, session })}
                        >
                          <ArrowRight className="size-4" />
                        </Button>
                      ) : (
                        <span className="whitespace-nowrap text-xs text-muted-foreground">Route setup required</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        {sessionsData?.meta.truncated && (
          <p className="mt-3 text-xs text-muted-foreground">Showing the first 50 sessions for this exact period.</p>
        )}
      </Panel>

      {currentSession && (
        <SessionDetail
          session={currentSession}
          metric={metric.key}
          range={range}
          onClose={() => setSelectedSession(null)}
        />
      )}

      <AcquisitionPanel metrics={metrics} env={env} trusted={acquisitionTrusted} range={range} />
    </div>
  );
}

function WebHealthAnswer({ current, previous, comparisonState, range, trust, trustLoading, env }: {
  current: WebAnalyticsResult;
  previous: WebAnalyticsResult | null;
  comparisonState: 'loading' | 'ready' | 'unavailable';
  range: ResolvedAnalyticsRange;
  trust: WebTrustRead;
  trustLoading: boolean;
  env: string;
}) {
  const currentViews = current.summary.page_views;
  const previousViews = previous?.summary.page_views ?? null;
  const delta = previousViews === null ? null : currentViews - previousViews;
  const deltaRate = previousViews === null || previousViews === 0 || delta === null ? null : delta / previousViews;
  const days = range.days;
  const comparison = comparisonState === 'loading'
    ? 'Previous-period comparison is loading.'
    : delta === null
    ? 'Previous-period comparison is unavailable.'
    : delta === 0
    ? `No change versus the previous ${days} days.`
    : deltaRate === null
      ? `${delta > 0 ? '+' : ''}${fmtNum(delta)} page views; the previous period was zero, so percentage change is unavailable.`
      : `${delta > 0 ? 'Up' : 'Down'} ${Math.abs(deltaRate * 100).toFixed(1)}% versus the previous ${days} days.`;
  const trustLabel = trustLoading
    ? 'Trust evidence loading'
    : trust.result?.status === 'trusted' && !trust.unavailable
    ? 'Trusted measurement'
    : trust.unavailable ? 'Trust evidence unavailable' : 'Partial measurement trust';
  const observed = trust.result?.primary_metric.observed_events ?? currentViews;
  return (
    <AnswerCanvas>
      <div className="grid gap-4 p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end sm:p-5">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold">Web health</h2>
            <HelpDisclosure ariaLabel="About web health evidence" label={`${trustLabel}. ${fmtNum(observed)} observed events in ${env}.`} />
          </div>
          <p className="mt-2 text-xl font-semibold">{fmtNum(currentViews)} canonical page views across {fmtNum(current.summary.sessions)} sessions</p>
          <p className="mt-1 text-sm text-muted-foreground">{comparison}</p>
        </div>
        <Badge variant={trust.result?.status === 'trusted' && !trust.unavailable ? 'outline' : 'secondary'}>
          {comparisonState === 'loading' ? 'Comparison loading'
            : delta === null ? 'Comparison unavailable'
              : delta === 0 ? 'Stable' : `${delta > 0 ? '+' : ''}${fmtNum(delta)} views`}
        </Badge>
      </div>
    </AnswerCanvas>
  );
}

function WebOutcomeAnswer({ metric, current, currentState, currentError, previous, comparisonState, range, env, onRetry }: {
  metric: Metric;
  current: TrendQueryResult | null;
  currentState: 'loading' | 'ready' | 'unavailable' | 'unsupported';
  currentError: string | null;
  previous: TrendQueryResult | null;
  comparisonState: 'loading' | 'ready' | 'unavailable';
  range: ResolvedAnalyticsRange;
  env: string;
  onRetry: () => void;
}) {
  if (currentState === 'loading') {
    return <AnswerCanvas><div className="p-4 sm:p-5"><Loading what={`Measuring ${metric.name}…`} /></div></AnswerCanvas>;
  }
  if (currentState === 'unsupported') {
    return (
      <AnswerCanvas>
        <div className="grid gap-4 p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start sm:p-5">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold">Web outcome</h2>
              <HelpDisclosure ariaLabel="Why this outcome needs the funnel view" label={<><code>{metric.key}</code> is a conversion definition. Trend queries reject it, so this screen will not infer a rate or zero. {metric.purpose} · {env}</>} />
            </div>
            <p className="mt-2 text-lg font-semibold">{metric.name} needs the funnel view</p>
          </div>
          <Button asChild variant="outline"><Link to="/analyze">Open Analyze</Link></Button>
        </div>
      </AnswerCanvas>
    );
  }
  if (currentState === 'unavailable' || !current) {
    return (
      <AnswerCanvas>
        <div className="p-4 sm:p-5">
          <h2 className="text-lg font-semibold">Web outcome</h2>
          <p className="mt-2 text-sm text-muted-foreground">{metric.name} could not be measured for this exact period. Traffic remains available and no zero is inferred.</p>
          {currentError && <div className="mt-3"><ErrorNote>{currentError}</ErrorNote></div>}
          <Button variant="outline" className="mt-3" onClick={onRetry}>Retry outcome</Button>
        </div>
      </AnswerCanvas>
    );
  }
  const hasObservations = current.series.length > 0 && current.answer?.state !== 'empty';
  const currentValue = webOutcomeValue(metric, current);
  const previousValue = previous ? webOutcomeValue(metric, previous) : null;
  const delta = currentValue !== null && previousValue !== null ? currentValue - previousValue : null;
  const deltaRate = delta !== null && previousValue !== null && previousValue !== 0
    ? delta / Math.abs(previousValue)
    : null;
  const days = range.days;
  const comparison = comparisonState === 'loading'
    ? 'Previous exact-period comparison is loading.'
    : comparisonState === 'unavailable' || delta === null
      ? 'Previous exact-period comparison is unavailable.'
      : delta === 0
        ? `No change versus the previous ${days} days.`
        : deltaRate === null
          ? `${delta > 0 ? '+' : ''}${formatOutcomeNumber(delta)}; the previous period was zero, so percentage change is unavailable.`
          : `${delta > 0 ? 'Up' : 'Down'} ${Math.abs(deltaRate * 100).toFixed(1)}% versus the previous ${days} days.`;
  const trust = current.evidence?.state ?? 'unavailable';
  const aggregation = current.evidence?.aggregation ?? 'Registered metric query; aggregation details unavailable.';
  return (
    <AnswerCanvas>
      <div className="grid gap-4 p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end sm:p-5">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold">Web outcome</h2>
            <HelpDisclosure ariaLabel="About web outcome evidence" label={<><code>{metric.key}</code> · {metric.purpose} · {env}. {aggregation}</>} />
          </div>
          <p className="mt-2 text-xl font-semibold">
            {hasObservations && currentValue !== null
              ? `${metric.name}: ${current.answer?.primary_value?.formatted ?? formatOutcomeNumber(currentValue)}`
              : `No ${metric.name} observations in this period`}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">{hasObservations ? comparison : 'The query returned no observations; this is not presented as a measured zero conversion.'}</p>
        </div>
        <Badge variant={trust === 'trusted' ? 'outline' : 'secondary'}>
          {trust === 'trusted' ? 'Trusted query evidence' : `${trust} evidence`}
        </Badge>
      </div>
    </AnswerCanvas>
  );
}

function webOutcomeValue(metric: Metric, result: TrendQueryResult): number | null {
  const primary = result.answer?.primary_value?.value;
  if (typeof primary === 'number' && Number.isFinite(primary)) return primary;
  if (metric.type === 'count') return result.series.reduce((sum, point) => sum + point.value, 0);
  const source = metric.source as { agg?: string };
  if (metric.type === 'value' && (source.agg ?? 'sum') === 'sum') {
    return result.series.reduce((sum, point) => sum + point.value, 0);
  }
  return null;
}

function formatOutcomeNumber(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);
}

export function hasAcceptedCanonicalPageViews(pageViews: number) {
  return pageViews > 0;
}

export function hasWebOutcome(metrics: Metric[]) {
  return webOutcomeMetric(metrics) !== null;
}

export function webOutcomeMetric(metrics: Metric[]): Metric | null {
  return metrics.filter((metric) => metric.status === 'active'
    && metric.key !== WEB_PAGE_VIEW_METRIC
    && metric.type !== 'state'
    && metric.tags.includes('surface:web'))
    .sort((left, right) => {
      const leftQueryable = left.type === 'conversion' ? 1 : 0;
      const rightQueryable = right.type === 'conversion' ? 1 : 0;
      return leftQueryable - rightQueryable || left.key.localeCompare(right.key);
    })[0] ?? null;
}

export function previousExactRange(range?: { from: string; to: string }): { from: string; to: string } | null {
  if (!range) return null;
  const from = Date.parse(range.from);
  const to = Date.parse(range.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return null;
  return {
    from: new Date(from - (to - from)).toISOString(),
    to: new Date(from).toISOString(),
  };
}

export function webConversionMetric(metrics: Metric[]): Metric | null {
  return [...metrics]
    .filter((metric) => metric.status === 'active'
      && metric.type === 'conversion'
      && metric.tags.includes('surface:web'))
    .sort((left, right) => left.key.localeCompare(right.key))[0] ?? null;
}

function WebConversionAnswer({ metric, result, loading, error, onRetry }: {
  metric: Metric;
  result: FunnelQueryResult | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  if (loading) return <Loading what={`Loading ${metric.name} conversion…`} />;
  if (error) {
    return (
      <div className="border-y border-dashed px-4 py-5">
        <ErrorNote>{error}</ErrorNote>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button variant="outline" className="h-11" onClick={onRetry}>Retry conversion</Button>
          <Button asChild variant="outline" className="h-11"><Link to="/registry">Review definition</Link></Button>
        </div>
      </div>
    );
  }
  if (!result?.summary) {
    return <EmptyState headline="Conversion unavailable" lead="The typed funnel response did not include a conversion summary." />;
  }
  const first = result.steps[0]?.actors ?? 0;
  const last = result.steps.at(-1)?.actors ?? 0;
  const current = result.summary.overall_conversion;
  const previous = result.summary.previous_overall_conversion;
  const delta = result.summary.delta_percentage_points;
  const deltaLabel = delta === null
    ? 'Previous exact-period comparison unavailable'
    : `${delta > 0 ? '+' : ''}${Math.round(delta * 10) / 10} pp versus previous exact period`;
  return (
    <section className="border-y" aria-labelledby="web-conversion-title">
      <div className="grid gap-4 px-4 py-5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 id="web-conversion-title" className="text-lg font-semibold">{metric.name}</h3>
            <HelpDisclosure ariaLabel="About conversion evidence" label={<>{metric.purpose}<br />Exact UTC window: [{result.meta.date_range.from}, {result.meta.date_range.to}) · {result.evidence?.aggregation ?? 'registered conversion definition'} · {result.meta.source}</>} />
          </div>
          {current === null ? (
            <>
              <p className="mt-4 text-xl font-semibold">No measured denominator</p>
              <p className="mt-1 text-sm text-muted-foreground">Conversion rate is unavailable; no actor reached the registered start source in this period.</p>
            </>
          ) : (
            <>
              <p className="mt-4 text-3xl font-semibold tabular-nums">{formatPercent(current)}</p>
              <p className="mt-1 text-sm text-muted-foreground">{fmtNum(last)} of {fmtNum(first)} actors converted</p>
            </>
          )}
        </div>
        <Badge variant={result.evidence?.state === 'trusted' ? 'outline' : 'secondary'}>{deltaLabel}</Badge>
      </div>
      <div className="grid gap-3 border-t bg-muted/20 px-4 py-3 text-sm sm:grid-cols-3">
        <ConversionFact label="Current conversion" value={current === null ? 'Unavailable' : formatPercent(current)} />
        <ConversionFact label="Previous conversion" value={previous === null ? 'Unavailable' : formatPercent(previous)} />
        <ConversionFact label="Converted actors" value={current === null ? 'Unavailable' : `${fmtNum(last)} of ${fmtNum(first)}`} />
      </div>
    </section>
  );
}

function ConversionFact({ label, value }: { label: string; value: string }) {
  return <div><span className="text-muted-foreground">{label}</span><div className="mt-1 font-medium tabular-nums">{value}</div></div>;
}

function routeDefinitionsReady(properties: PropertyDefinition[]) {
  const route = properties.find((property) => property.scope === 'event' && property.key === '$route_key');
  return route?.status === 'trusted' && (route.enum_values?.length ?? 0) > 0;
}

function WebOutcomeSetup() {
  return (
    <AnswerCanvas>
      <div className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
        <div>
          <h2 className="text-lg font-semibold">Define the first web outcome</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">Traffic is measurable and acquisition properties are trusted. Activate one outcome tagged <code>surface:web</code> before reading conversion.</p>
        </div>
        <Button asChild className="h-11 shrink-0"><Link to="/registry">Review outcomes</Link></Button>
      </div>
    </AnswerCanvas>
  );
}

function WebSetup({ metric, onReady }: { metric: Metric | null; onReady: () => void }) {
  const { client, project } = useStore();
  const [routeKeysInput, setRouteKeysInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const createPlan = async () => {
    setBusy(true);
    setError(null);
    try {
      await client!.proposeBrowserAnalytics(project!, parseWebRouteKeys(routeKeysInput));
      onReady();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not create the web tracking plan.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <KpiRail items={[
        { label: 'Visitors', value: '—' },
        { label: 'Sessions', value: '—' },
        { label: 'Sources & UTM', value: '—' },
        { label: 'Top pages', value: '—' },
      ]} />
      <AnswerCanvas>
        {metric ? (
          <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-lg font-semibold">Tracking plan ready</h2>
              <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
                Review and activate <code>{WEB_PAGE_VIEW_METRIC}</code>, then open one real page to see visitors, sessions and acquisition.
              </p>
            </div>
            <Button asChild className="h-11 shrink-0"><Link to="/registry">Review and activate</Link></Button>
          </div>
        ) : (
          <div className="p-5">
            <h2 className="text-lg font-semibold">Add website analytics</h2>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">Choose routes to compare.</p>
            <div className="mt-5 max-w-2xl">
              <div className="flex items-center gap-2">
                <label htmlFor="web-route-keys" className="text-sm font-medium">Safe route keys</label>
                <HelpDisclosure ariaLabel="About safe route keys" label={<>Use stable names such as <code>home</code>, <code>pricing</code>, or <code>docs.article</code>. Do not paste full URLs.</>} />
              </div>
              <Input
                id="web-route-keys"
                className="mt-3 h-11"
                value={routeKeysInput}
                onChange={(event) => setRouteKeysInput(event.target.value)}
                placeholder="home, pricing, docs.article"
              />
              {error && <div className="mt-3"><ErrorNote>{error}</ErrorNote></div>}
              <Button className="mt-4 h-11" onClick={createPlan} disabled={busy || routeKeysInput.trim().length === 0}>
                {busy ? 'Creating plan…' : 'Create web tracking plan'}
              </Button>
            </div>
          </div>
        )}
      </AnswerCanvas>
    </>
  );
}

function WebRepair({ state }: { state: Exclude<WebDefinitionRepairState, { kind: 'ready' }> }) {
  const { client, project } = useStore();
  const [routeKeysInput, setRouteKeysInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const repair = async () => {
    setBusy(true);
    setError(null);
    try {
      if (state.kind === 'missing_utm') {
        await client!.proposeAcquisitionProperties(project!);
      } else {
        const routeKeys = state.kind === 'missing_route'
          ? parseWebRouteKeys(routeKeysInput)
          : state.kind === 'missing_browser' ? state.routeKeys : [];
        await client!.proposeBrowserAnalytics(project!, routeKeys);
      }
      setSubmitted(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not repair the web tracking plan.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AnswerCanvas>
      <div className="p-5">
        {submitted || state.kind === 'review' ? (
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-lg font-semibold">Tracking definitions ready</h2>
              <p className="mt-1 max-w-2xl text-sm text-muted-foreground">Review the existing route and UTM definitions, then trust the ones this customer-facing report should use.</p>
            </div>
            <Button asChild className="h-11 shrink-0"><Link to="/registry">Review and activate</Link></Button>
          </div>
        ) : (
          <>
            <h2 className="text-lg font-semibold">Finish web setup</h2>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              {state.kind === 'missing_route'
                ? 'Add the safe route vocabulary used by this website. Poolstatis will also propose any missing browser and UTM definitions.'
                : state.kind === 'missing_browser'
                  ? 'Add the missing browser definitions without changing the existing trusted route vocabulary.'
                  : 'Add the five canonical UTM definitions without changing routes or the active page-view metric.'}
            </p>
            <div className="mt-4 flex max-w-2xl flex-col gap-3 sm:flex-row sm:items-end">
              {state.kind === 'missing_route' && <label htmlFor="repair-web-route-keys" className="grid min-w-0 flex-1 gap-1.5 text-sm font-medium">
                Safe route keys
                <Input id="repair-web-route-keys" className="h-11" value={routeKeysInput} onChange={(event) => setRouteKeysInput(event.target.value)} placeholder="home, pricing, docs.article" />
              </label>}
              <Button className="h-11" onClick={repair} disabled={busy || (state.kind === 'missing_route' && routeKeysInput.trim().length === 0)}>
                {busy ? 'Repairing…' : state.kind === 'missing_utm' ? 'Add UTM definitions' : 'Repair web tracking'}
              </Button>
            </div>
            {state.kind === 'missing_route' && <p className="mt-2 text-sm text-muted-foreground">Use stable labels only. Full URLs, paths, query strings and user IDs are rejected.</p>}
            {error && <div className="mt-3"><ErrorNote>{error}</ErrorNote></div>}
          </>
        )}
      </div>
    </AnswerCanvas>
  );
}

function WebTrafficOverview({
  overview,
  trend,
  trendError,
  onRetryTrend,
  trust,
  env,
  metric,
  range,
  selection,
  onRange,
  refreshing,
}: {
  overview: WebAnalyticsResult;
  trend: TrendQueryResult | null;
  trendError: string | null;
  onRetryTrend: () => void;
  trust: WebTrustRead;
  env: string;
  metric: Metric;
  range: ResolvedAnalyticsRange;
  selection: AnalyticsRangeSelection;
  onRange: (range: AnalyticsRangeSelection) => void;
  refreshing: boolean;
}) {
  const evidence = webEvidenceTrust(trust);
  const evidenceLabel = evidence === 'trusted' ? 'Trusted' : evidence === 'partial' ? 'Partial' : 'Unavailable';
  const eventCount = trust.result?.primary_metric.observed_events ?? overview.summary.page_views;
  return (
    <AnswerCanvas>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3 sm:px-5" aria-busy={refreshing}>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold">Traffic overview</h2>
            <HelpDisclosure
              ariaLabel="How traffic is calculated"
              label={<>The active <code>{metric.key}</code> definition counts accepted canonical page views. Visitors and sessions use actor-safe server aggregates for the selected UTC period.</>}
            />
          </div>
          <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
            <span className={`size-2 shrink-0 rounded-full ${evidence === 'trusted' ? 'bg-success' : evidence === 'partial' ? 'bg-warning' : 'bg-muted-foreground/60'}`} aria-hidden="true" />
            <span>{evidenceLabel} · {eventCount.toLocaleString()} events · <code>{env}</code></span>
            {refreshing && <span role="status">Updating…</span>}
          </div>
        </div>
        <AnalyticsDateRange value={selection} onChange={onRange} />
      </div>
      <KpiRail
        className="rounded-none border-0 shadow-none"
        items={[
          { label: 'Visitors', value: fmtNum(overview.summary.visitors), detail: 'resolved actors' },
          { label: 'Sessions', value: fmtNum(overview.summary.sessions), detail: 'canonical sessions' },
          { label: 'Page views', value: fmtNum(overview.summary.page_views), detail: 'accepted views' },
          { label: 'Average duration', value: overview.summary.average_session_duration_ms === null ? 'Unavailable' : formatDurationMs(overview.summary.average_session_duration_ms), detail: 'complete sessions' },
          { label: 'Measured coverage', value: formatPercent(overview.engagement.measured_session_coverage), detail: 'eligible sessions' },
          { label: 'Engaged rate', value: formatPercent(overview.engagement.engaged_rate), detail: 'measured sessions' },
          { label: 'Bounce rate', value: formatPercent(overview.engagement.bounce_rate), detail: 'measured sessions' },
        ]}
      />
      <div className="border-t p-4 sm:p-5">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold">Page views over time</h3>
          <span className="text-xs text-muted-foreground">{range.label}</span>
        </div>
        {trend
          ? <TrendChart result={trend} label="Page views over time" />
          : trendError
            ? <div><ErrorNote>{trendError}</ErrorNote><Button variant="outline" className="mt-3" onClick={onRetryTrend}>Retry trend</Button></div>
            : <Loading what="Loading traffic trend…" />}
      </div>
    </AnswerCanvas>
  );
}

function ScreenHeader() {
  return (
    <PageHeading
      title="Web"
      lead="Traffic, engagement, and outcomes."
      help="Traffic uses canonical browser events. Outcomes appear only when a purpose-backed metric is registered and the exact query is supported."
    />
  );
}

function SessionState({ session }: { session: WebSessionSummary }) {
  const label = engagementLabel(session.engaged);
  const variant = session.engaged === true ? 'default' : session.engaged === false ? 'secondary' : 'outline';
  return <Badge variant={variant}>{label}</Badge>;
}

function UnavailableDimension({ label, unavailable }: {
  label: string;
  unavailable: { reason: string; next_action: string };
}) {
  return (
    <div className="border-y border-dashed px-4 py-7 text-center">
      <div className="serif text-xl">{label} unavailable</div>
      <p className="mx-auto mt-1 max-w-lg text-sm text-muted-foreground">
        {unavailable.reason}
      </p>
      <p className="mx-auto mt-2 max-w-lg text-xs text-muted-foreground">{unavailable.next_action}</p>
    </div>
  );
}

function SessionDetail({ session, metric, range, onClose }: {
  session: WebSessionSummary;
  metric: string;
  range: ResolvedAnalyticsRange;
  onClose: () => void;
}) {
  const { client, project, env } = useStore();
  const detail = useAsync<WebSessionResult>(() => client!.operationalQuery<WebSessionResult>(project!, {
    kind: 'web_session',
    metric,
    session_id: session.session_id,
    actor_id: session.actor_id,
    date_from: range.from,
    date_to: range.to,
    filters: [],
    page_limit: 100,
    env,
  }), [project, env, metric, session.session_id, session.actor_id, range.from, range.to]);

  return (
    <section className="overflow-hidden rounded-dialog border bg-card" aria-labelledby="web-session-title">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b px-4 py-4 sm:px-5">
        <div className="min-w-0">
          <h2 id="web-session-title" className="serif text-xl">Session detail</h2>
          <div className="mt-1 break-all font-mono text-xs text-muted-foreground">{session.session_id}</div>
        </div>
        <Button variant="outline" className="h-11 md:h-9" onClick={onClose}>Close</Button>
      </header>
      {detail.loading && <Loading what="reading canonical session…" />}
      {detail.error && <div className="p-4"><ErrorNote>{detail.error}</ErrorNote></div>}
      {detail.data && (detail.data.pages.length === 0 ? (
        <EmptyState headline="No page evidence" lead={detail.data.meta.no_data_reason} />
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Route</TableHead>
                <TableHead>Viewed</TableHead>
                <TableHead className="text-right">Foreground</TableHead>
                <TableHead className="text-right">Scroll</TableHead>
                <TableHead>Evidence</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {detail.data.pages.map((page) => (
                <TableRow key={page.page_view_id}>
                  <TableCell className="font-mono text-xs">{page.route}</TableCell>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{formatDateTime(page.viewed_at)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatDurationMs(page.foreground_ms)}</TableCell>
                  <TableCell className="text-right tabular-nums">{page.max_scroll_pct === null ? 'Unavailable' : `${page.max_scroll_pct}%`}</TableCell>
                  <TableCell><Badge variant={page.complete ? 'default' : 'outline'}>{page.complete ? 'Complete' : 'Incomplete'}</Badge></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ))}
      {detail.data?.meta.truncated && <div className="border-t px-4 py-3 text-xs text-muted-foreground">Page evidence is truncated at 100 rows.</div>}
    </section>
  );
}

function WebAnalyticsSkeleton() {
  return (
    <div className="space-y-5" aria-label="Loading web analytics">
      <div className="h-11 w-56 animate-pulse rounded-control bg-muted motion-reduce:animate-none" />
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => <div key={index} className="h-28 animate-pulse rounded-panel border bg-muted/70 motion-reduce:animate-none" />)}
      </div>
      <div className="h-80 animate-pulse rounded-dialog border bg-muted/60 motion-reduce:animate-none" />
    </div>
  );
}

interface WebTrustRead {
  result: MeasurementTrust | null;
  unavailable: boolean;
}

async function readWebTrust(
  client: NonNullable<ReturnType<typeof useStore>['client']>,
  project: string,
  env: string,
  metric: string,
  days: number,
): Promise<WebTrustRead> {
  if (typeof client.measurementTrust !== 'function') return { result: null, unavailable: true };
  try {
    return { result: await client.measurementTrust(project, { metric_key: metric, env, since_days: Math.min(days, 365), target_filters: [] }), unavailable: false };
  } catch {
    return { result: null, unavailable: true };
  }
}

function webEvidenceTrust(trust: WebTrustRead): EvidenceTrust {
  if (trust.unavailable || !trust.result) return 'unavailable';
  return trust.result.status === 'trusted' ? 'trusted' : 'blocked';
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}
