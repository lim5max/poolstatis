import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight } from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { EmptyState, ErrorNote, Loading, Panel, fmtNum } from '@/components/ui';
import { AnswerCanvas, EvidenceLine, KpiStrip, type EvidenceTrust } from '@/components/analytics';
import { ManualVisualizationRenderer } from '../analysis/charts';
import {
  WEB_PAGE_VIEW_METRIC,
  engagementLabel,
  formatDurationMs,
  formatPercent,
  rangeDateFrom,
  webPageMetric,
  type AnalyticsRange,
  type WebAnalyticsResult,
  type WebDimension,
  type WebSessionResult,
  type WebSessionSummary,
  type WebSessionsResult,
  type WebWorkspaceResult,
} from '../analysis/operations';
import type { TrendQueryResult, VisualizationSpec } from '../analysis/visualization';
import type { MeasurementReadiness, MeasurementTrust, Metric, PropertyDefinition } from '../api/types';
import { useAsync, useStore } from '../store';
import { AcquisitionPanel } from './Measurement';

const RANGE_OPTIONS: Array<{ value: AnalyticsRange; label: string }> = [
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: '90d', label: 'Last 90 days' },
];
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

interface WebReadinessRead {
  scope: string;
  result: MeasurementReadiness | null;
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
  const { client, project, env } = useStore();
  const [range, setRange] = useState<AnalyticsRange>('30d');
  const [dimension, setDimension] = useState<BreakdownView>('source');
  const [selectedSession, setSelectedSession] = useState<{ scope: string; session: WebSessionSummary } | null>(null);
  const [sessionsRequested, setSessionsRequested] = useState(false);
  const [breakdownRequested, setBreakdownRequested] = useState(false);
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
  const readiness = useAsync<WebReadinessRead>(async () => ({
    scope: registryScope,
    result: typeof client!.measurementReadiness === 'function'
      ? await client!.measurementReadiness(project!, env).catch(() => null)
      : null,
  }), [project, env]);
  const readinessData = readiness.data?.scope === registryScope ? readiness.data.result : null;
  const metric = registryData?.metric ?? null;
  const outcomeMetric = registryData ? webOutcomeMetric(registryData.metrics) : null;
  const primaryScope = `${registryScope}\u0000${range}\u0000${metric?.key ?? ''}`;
  const outcomeScope = `${registryScope}\u0000${range}\u0000${outcomeMetric?.key ?? ''}`;
  const primary = useAsync<WebPrimaryRead | null>(async () => {
    if (!metric) return null;
    const base = {
      metric: metric.key,
      date_from: rangeDateFrom(range),
      filters: [],
      env,
    };
    const overview = await client!.operationalQuery<WebAnalyticsResult>(project!, {
      kind: 'web_analytics',
      ...base,
      dimensions: [],
    });
    return { scope: primaryScope, metric, overview };
  }, [project, env, range, metric?.key]);
  const primaryData = primary.data?.scope === primaryScope ? primary.data : null;
  const comparison = useAsync<WebComparisonRead | null>(async () => {
    if (!metric || !primaryData) return null;
    const days = Number.parseInt(range, 10);
    const result = await client!.operationalQuery<WebAnalyticsResult>(project!, {
      kind: 'web_analytics', metric: metric.key, date_from: `-${days * 2}d`, date_to: `-${days}d`,
      filters: [], env, dimensions: [],
    });
    return { scope: primaryScope, result };
  }, [project, env, range, metric?.key, primaryData?.overview.meta.computed_at]);
  const comparisonData = comparison.data?.scope === primaryScope ? comparison.data.result : null;
  const trendRead = useAsync<WebTrendRead | null>(async () => {
    if (!metric || !primaryData) return null;
    const result = await client!.query(project!, {
      kind: 'trend', metric: metric.key, date_from: rangeDateFrom(range), date_to: null,
      interval: 'day', filters: [], env,
    });
    if (result.kind !== 'trend') throw new Error('Trend query returned an unexpected result kind');
    return { scope: primaryScope, result };
  }, [project, env, range, metric?.key, primaryData?.overview.meta.computed_at]);
  const trendData = trendRead.data?.scope === primaryScope ? trendRead.data.result : null;
  const trustRead = useAsync<WebTrustScopedRead | null>(async () => {
    if (!metric || !primaryData) return null;
    return { scope: primaryScope, result: await readWebTrust(client!, project!, env, metric.key) };
  }, [project, env, range, metric?.key, primaryData?.overview.meta.computed_at]);
  const trustData = trustRead.data?.scope === primaryScope ? trustRead.data.result : null;
  const outcomeRead = useAsync<WebOutcomeRead | null>(async () => {
    if (!outcomeMetric || outcomeMetric.type === 'conversion') return null;
    const result = await client!.query(project!, {
      kind: 'trend', metric: outcomeMetric.key, date_from: rangeDateFrom(range), date_to: null,
      interval: 'day', filters: [], env,
    });
    if (result.kind !== 'trend') throw new Error('Outcome query returned an unexpected result kind');
    return { scope: outcomeScope, metric: outcomeMetric, result };
  }, [project, env, range, outcomeMetric?.key, outcomeMetric?.type]);
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
    project, env, range, outcomeMetric?.key, outcomeData?.result.meta.computed_at,
    outcomeData?.result.meta.date_range?.from, outcomeData?.result.meta.date_range?.to,
  ]);
  const outcomeComparisonData = outcomeComparison.data?.scope === outcomeScope
    ? outcomeComparison.data.result
    : null;
  const operationalDimension = dimension !== 'conversion' ? dimension : null;
  const secondary = useAsync<WebSecondaryRead | null>(async () => {
    if (!metric || !primaryData || !breakdownRequested || !operationalDimension) return null;
    const result = await client!.operationalQuery<WebAnalyticsResult>(project!, {
      kind: 'web_analytics',
      metric: metric.key,
      date_from: rangeDateFrom(range),
      filters: [],
      env,
      dimensions: [operationalDimension],
    });
    return { scope: primaryScope, dimension: operationalDimension, result };
  }, [project, env, range, metric?.key, primaryData?.overview.meta.computed_at, operationalDimension, breakdownRequested]);
  const secondaryData = secondary.data?.scope === primaryScope
    && secondary.data.dimension === operationalDimension ? secondary.data.result : null;
  const sessions = useAsync<WebSessionsRead | null>(async () => {
    if (!metric || !primaryData || !sessionsRequested) return null;
    const result = await client!.operationalQuery<WebSessionsResult>(project!, {
      kind: 'web_sessions', metric: metric.key, date_from: rangeDateFrom(range), filters: [], env, limit: 50,
    });
    return { scope: primaryScope, result };
  }, [project, env, range, metric?.key, primaryData?.overview.meta.computed_at, sessionsRequested]);
  const sessionsData = sessions.data?.scope === primaryScope ? sessions.data.result : null;
  const currentSession = selectedSession?.scope === primaryScope ? selectedSession.session : null;

  useEffect(() => {
    setSelectedSession(null);
    setSessionsRequested(false);
    setBreakdownRequested(false);
  }, [project, env, range]);

  if (registry.loading || (!registryData && !registry.error)) return <WebAnalyticsSkeleton />;
  if (registry.error) return <ErrorNote>{registry.error}</ErrorNote>;
  if (!registryData) return null;
  if (!metric) {
    const setupData = registryData;
    const acquisitionTrusted = UTM_PROPERTY_KEYS.every((key) => setupData.properties.some(
      (property) => property.key === key && property.scope === 'event' && property.status === 'trusted',
    ));
    const outcomeReady = hasWebOutcome(setupData.metrics);
    const affectedAnswerIds = webAffectedAnswerIds(readinessData, setupData.metrics);
    return (
      <div className="space-y-5">
        <ScreenHeader range={range} onRange={setRange} showRange={false} />
        <WebSetupOrder canonicalReady={false} acquisitionReady={acquisitionTrusted} outcomeReady={outcomeReady} affectedAnswerIds={affectedAnswerIds} />
        <WebSetup metric={setupData.proposedMetric} onReady={registry.reload} />
      </div>
    );
  }
  if (primary.loading || (!primaryData && !primary.error)) return <WebAnalyticsSkeleton />;
  if (primary.error) return <ErrorNote>{primary.error}</ErrorNote>;
  if (!primaryData) return null;

  const { overview } = primaryData;
  const { properties, metrics } = registryData;
  const trust = trustData ?? { result: null, unavailable: true };
  const spec = trendData ? webTrendSpec(project!, env, metric.name, metric.purpose, overview, trendData, trust) : null;
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
  const affectedAnswerIds = webAffectedAnswerIds(readinessData, metrics);

  return (
    <div className="space-y-5">
      <ScreenHeader range={range} onRange={(value) => { setRange(value); setSelectedSession(null); }} />

      {(!canonicalReady || !acquisitionTrusted || !outcomeReady) && (
        <WebSetupOrder canonicalReady={canonicalReady} acquisitionReady={acquisitionTrusted} outcomeReady={outcomeReady} affectedAnswerIds={affectedAnswerIds} />
      )}

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

      <KpiStrip items={[
        { label: 'Visitors', value: fmtNum(overview.summary.visitors), note: 'resolved actors' },
        { label: 'Sessions', value: fmtNum(overview.summary.sessions), note: 'actor + session ID' },
        { label: 'Page views', value: fmtNum(overview.summary.page_views), note: 'accepted canonical views' },
        { label: 'Average duration', value: overview.summary.average_session_duration_ms === null ? null : formatDurationMs(overview.summary.average_session_duration_ms), note: 'complete sessions only' },
      ]} />

      <EvidenceLine
        trust={webEvidenceTrust(trust)}
        eventCount={trust.result?.primary_metric.observed_events ?? overview.summary.page_views}
        env={env}
      >
        The active <code>{metric.key}</code> definition counts accepted canonical page views. Visitors and sessions use the server's actor-safe web response for this exact period.
      </EvidenceLine>

      {repairState.kind !== 'ready' && <WebRepair state={repairState} />}
      {repairState.kind === 'ready' && !outcomeReady && <WebOutcomeSetup />}

      <div className="grid gap-3 border-y bg-card/45 px-4 py-3 text-sm sm:grid-cols-3">
        <Rate label="Measured coverage" value={overview.engagement.measured_session_coverage} />
        <Rate label="Engaged rate" value={overview.engagement.engaged_rate} />
        <Rate label="Bounce rate" value={overview.engagement.bounce_rate} />
      </div>

      {trendData && spec ? <ManualVisualizationRenderer spec={spec} result={trendData} />
        : trendRead.error ? <div><ErrorNote>{trendRead.error}</ErrorNote><Button variant="outline" className="mt-3 h-11" onClick={trendRead.reload}>Retry trend</Button></div>
          : <Loading what="Loading traffic trend…" />}

      <AnswerCanvas>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3 sm:px-5">
          <h2 className="text-sm font-semibold">Traffic breakdown</h2>
          {!breakdownRequested
            ? <Badge variant="outline">Load on request</Badge>
            : !breakdownResponse && operationalDimension !== null
            ? <Badge variant="outline">Loading selected view</Badge>
            : breakdownResponse && breakdownResponse.meta.truncated_dimensions.length > 0
            ? <Badge variant="outline">Top values · truncated</Badge>
            : Object.keys(unavailableDimensions).length > 0
              ? <Badge variant="outline">Partial response</Badge>
              : <Badge variant="outline">Complete response</Badge>}
        </div>
        <div className="p-4 sm:p-5">
        <div className="mb-4 max-w-full overflow-x-auto">
          <Tabs value={dimension} onValueChange={(value) => { setDimension(value as BreakdownView); setBreakdownRequested(value !== 'conversion'); }}>
            <TabsList className="w-max">
              {DIMENSIONS.map((item) => <TabsTrigger key={item.value} value={item.value}>{item.label}</TabsTrigger>)}
            </TabsList>
          </Tabs>
        </div>
        {dimension === 'conversion' ? (
          <div className="border-y border-dashed px-4 py-7 text-center">
            <div className="text-lg font-semibold">{outcomeMetric ? outcomeMetric.name : 'Choose a conversion to measure'}</div>
            <p className="mx-auto mt-1 max-w-lg text-sm text-muted-foreground">
              {outcomeMetric
                ? `The registered ${outcomeMetric.key} outcome is measured above for this exact period; this tab does not reinterpret traffic as conversion.`
                : 'No active non-page-view metric is mapped to surface:web, so Poolstatis will not display a zero.'}
            </p>
            <Button asChild variant="outline" className="mt-4 h-11"><Link to={outcomeMetric ? '/analyze' : '/registry'}>{outcomeMetric ? 'Analyze outcome' : 'Review outcomes'}</Link></Button>
          </div>
        ) : !breakdownRequested ? (
          <div className="flex flex-col items-start gap-3 border-y border-dashed px-4 py-7">
            <div className="text-lg font-semibold">Traffic dimensions load when requested</div>
            <p className="max-w-2xl text-sm text-muted-foreground">The current Web answer stays visible while sources, pages and campaign dimensions load independently.</p>
            <Button variant="outline" className="h-11" onClick={() => setBreakdownRequested(true)}>Load traffic breakdown</Button>
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
                        to={`/analyze/users/${encodeURIComponent(session.actor_id)}`}
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

      <AcquisitionPanel metrics={metrics} env={env} trusted={acquisitionTrusted} />
    </div>
  );
}

function WebHealthAnswer({ current, previous, comparisonState, range, trust, trustLoading, env }: {
  current: WebAnalyticsResult;
  previous: WebAnalyticsResult | null;
  comparisonState: 'loading' | 'ready' | 'unavailable';
  range: AnalyticsRange;
  trust: WebTrustRead;
  trustLoading: boolean;
  env: string;
}) {
  const currentViews = current.summary.page_views;
  const previousViews = previous?.summary.page_views ?? null;
  const delta = previousViews === null ? null : currentViews - previousViews;
  const deltaRate = previousViews === null || previousViews === 0 || delta === null ? null : delta / previousViews;
  const days = Number.parseInt(range, 10);
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
          <h2 className="text-lg font-semibold">Web health</h2>
          <p className="mt-2 text-xl font-semibold">{fmtNum(currentViews)} canonical page views across {fmtNum(current.summary.sessions)} sessions</p>
          <p className="mt-1 text-sm text-muted-foreground">{comparison}</p>
          <p className="mt-2 text-xs text-muted-foreground">{trustLabel} · {fmtNum(observed)} observed events · {env}</p>
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
  range: AnalyticsRange;
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
            <h2 className="text-lg font-semibold">Web outcome</h2>
            <p className="mt-2 text-lg font-semibold">{metric.name} is registered, but not reproduced here</p>
            <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
              <code>{metric.key}</code> is a conversion definition. The typed trend query intentionally rejects conversion metrics, so this screen will not manufacture a rate or zero; query the registered funnel endpoints in Analyze.
            </p>
            <p className="mt-2 text-xs text-muted-foreground">{metric.purpose} · {env}</p>
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
  const days = Number.parseInt(range, 10);
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
          <h2 className="text-lg font-semibold">Web outcome</h2>
          <p className="mt-2 text-xl font-semibold">
            {hasObservations && currentValue !== null
              ? `${metric.name}: ${current.answer?.primary_value?.formatted ?? formatOutcomeNumber(currentValue)}`
              : `No ${metric.name} observations in this period`}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">{hasObservations ? comparison : 'The query returned no observations; this is not presented as a measured zero conversion.'}</p>
          <p className="mt-2 text-xs text-muted-foreground"><code>{metric.key}</code> · {metric.purpose} · {env}</p>
          <p className="mt-1 text-xs text-muted-foreground">{aggregation}</p>
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

function routeDefinitionsReady(properties: PropertyDefinition[]) {
  const route = properties.find((property) => property.scope === 'event' && property.key === '$route_key');
  return route?.status === 'trusted' && (route.enum_values?.length ?? 0) > 0;
}

function WebSetupOrder({ canonicalReady, acquisitionReady, outcomeReady, affectedAnswerIds = [] }: {
  canonicalReady: boolean;
  acquisitionReady: boolean;
  outcomeReady: boolean;
  affectedAnswerIds?: string[];
}) {
  const steps = [
    { title: 'Canonical page views', ready: canonicalReady, description: 'Active web_page_views metric and accepted browser events in this period.' },
    { title: 'Trusted acquisition properties', ready: acquisitionReady, description: 'Reviewed source, medium, campaign, term, and content definitions.' },
    { title: 'Outcome', ready: outcomeReady, description: 'One active non-page-view metric tagged surface:web for conversion or product value.' },
  ];
  const current = steps.findIndex((step) => !step.ready);
  return (
    <section className="rounded-panel border bg-card p-4 sm:p-5" aria-labelledby="web-setup-order-title">
      <div>
        <h2 id="web-setup-order-title" className="text-sm font-semibold">Web setup order</h2>
        <p className="mt-1 text-sm text-muted-foreground">Finish the first incomplete prerequisite; later answers remain unavailable rather than showing zero.</p>
      </div>
      <ol className="mt-4 grid gap-3 lg:grid-cols-3">
        {steps.map((step, index) => (
          <li key={step.title} className={`rounded-control border p-3 ${current === index ? 'border-primary/50 bg-primary/10' : step.ready ? 'bg-muted/30' : 'border-dashed'}`}>
            <div className="flex items-center justify-between gap-3 text-sm"><span className="font-medium">{index + 1}. {step.title}</span><span className="text-muted-foreground">{step.ready ? 'Ready' : current === index ? 'Next' : 'Pending'}</span></div>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{step.description}</p>
          </li>
        ))}
      </ol>
      {affectedAnswerIds.length > 0 && (
        <div className="mt-4 border-t pt-3 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Affected saved answers:</span>{' '}
          <span className="inline-flex flex-wrap gap-x-2 gap-y-1">
            {affectedAnswerIds.map((answerId) => (
              <Link key={answerId} className="font-mono text-foreground underline decoration-muted-foreground/60 underline-offset-4" to={`/analyze/saved?answer=${encodeURIComponent(answerId)}`}>
                {answerId}
              </Link>
            ))}
          </span>
        </div>
      )}
    </section>
  );
}

function webAffectedAnswerIds(readiness: MeasurementReadiness | null, metrics: Metric[]): string[] {
  if (!readiness) return [];
  const webRefs = new Set<string>([
    WEB_PAGE_VIEW_METRIC,
    ...BROWSER_PROPERTY_KEYS,
    ...UTM_PROPERTY_KEYS,
    ...metrics.filter((metric) => metric.tags.includes('surface:web')).map((metric) => metric.key),
  ]);
  return [...new Set(readiness.groups.flatMap((group) => group.gaps.flatMap((gap) => {
    const affectsWeb = group.key === 'data_sources'
      || (gap.definition_ref !== null && webRefs.has(gap.definition_ref));
    return affectsWeb ? gap.affected_answer_ids : [];
  })))].sort();
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
      <KpiStrip items={[
        { label: 'Visitors', value: null, fallback: 'Waiting for setup', note: 'Requires an accepted canonical page view' },
        { label: 'Sessions', value: null, fallback: 'Waiting for setup', note: 'Requires an accepted canonical page view' },
        { label: 'Sources & UTM', value: null, fallback: 'Waiting for setup', note: 'Requires trusted acquisition definitions' },
        { label: 'Top pages', value: null, fallback: 'Waiting for setup', note: 'Requires a reviewed safe route vocabulary' },
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
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              Name the safe route keys you want to compare. Poolstatis will create the page-view and UTM definitions for review.
            </p>
            <div className="mt-5 max-w-2xl">
              <label htmlFor="web-route-keys" className="text-sm font-medium">Safe route keys</label>
              <p className="mt-1 text-sm text-muted-foreground">Use stable names such as <code>home</code>, <code>pricing</code>, or <code>docs.article</code>. Do not paste full URLs.</p>
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

function ScreenHeader({ range, onRange, showRange = true }: {
  range: AnalyticsRange;
  onRange: (range: AnalyticsRange) => void;
  showRange?: boolean;
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="serif text-3xl sm:text-4xl">Web</h1>
        <p className="mt-1 text-sm text-muted-foreground">Traffic, pages, sources and supported conversions from canonical browser events.</p>
      </div>
      {showRange && <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
        Period
        <Select value={range} onValueChange={(value) => onRange(value as AnalyticsRange)}>
          <SelectTrigger className="!h-11 w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            {RANGE_OPTIONS.map((item) => <SelectItem className="min-h-11" key={item.value} value={item.value}>{item.label}</SelectItem>)}
          </SelectContent>
        </Select>
      </label>}
    </header>
  );
}

function Rate({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono font-medium tabular-nums">{formatPercent(value)}</span>
    </div>
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
  range: AnalyticsRange;
  onClose: () => void;
}) {
  const { client, project, env } = useStore();
  const detail = useAsync<WebSessionResult>(() => client!.operationalQuery<WebSessionResult>(project!, {
    kind: 'web_session',
    metric,
    session_id: session.session_id,
    actor_id: session.actor_id,
    date_from: rangeDateFrom(range),
    filters: [],
    page_limit: 100,
    env,
  }), [project, env, metric, session.session_id, session.actor_id, range]);

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

function webTrendSpec(
  project: string,
  env: string,
  metricName: string,
  purpose: string,
  overview: WebAnalyticsResult,
  trend: WebWorkspaceResult['trend'],
  trust: WebTrustRead,
): VisualizationSpec {
  const query = {
    kind: 'trend' as const,
    metric: WEB_PAGE_VIEW_METRIC,
    date_from: overview.meta.date_range.from,
    date_to: overview.meta.date_range.to,
    interval: 'day' as const,
    filters: [],
    env,
  };
  return {
    schemaVersion: 1,
    id: 'web-page-views-trend',
    kind: 'trend',
    title: metricName,
    question: 'How is canonical web traffic changing over this exact period?',
    purpose,
    project,
    env,
    range: { ...overview.meta.date_range, timezone: 'UTC' },
    source: { kind: 'metric', key: WEB_PAGE_VIEW_METRIC, query },
    trust: {
      status: trust.unavailable ? 'unavailable' : trust.result?.status === 'trusted' ? 'trusted' : 'partial',
      reason: trust.unavailable
        ? 'Measurement trust is unavailable for this exact project and environment.'
        : trust.result?.status === 'trusted'
          ? 'The server trust check passed for the canonical browser metric.'
          : trust.result?.blockers[0]?.message ?? 'The canonical browser metric has partial trust evidence.',
      blockers: trust.result?.blockers.map((blocker) => ({ code: blocker.code, message: blocker.message, nextAction: blocker.next_action })) ?? [],
    },
    evidence: {
      aggregation: 'count by day',
      denominator: null,
      sampleSize: overview.summary.page_views,
      coverage: overview.engagement.timed_page_coverage === null
        ? 'timing unavailable'
        : `${formatPercent(overview.engagement.timed_page_coverage)} timed pages`,
      source: 'native',
      computedAt: trend.meta.computed_at,
      comparisonBasis: 'none',
    },
    display: {
      valueFormat: 'number',
      granularity: 'day',
      compare: 'none',
      series: [{ key: 'value', label: 'Page views', colorToken: '--chart-1' }],
    },
    actions: [{ kind: 'open_metric', key: WEB_PAGE_VIEW_METRIC }, { kind: 'open_query', query }],
  };
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
): Promise<WebTrustRead> {
  if (typeof client.measurementTrust !== 'function') return { result: null, unavailable: true };
  try {
    return { result: await client.measurementTrust(project, { metric_key: metric, env, since_days: 30, target_filters: [] }), unavailable: false };
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
