import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight } from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
import type { VisualizationSpec } from '../analysis/visualization';
import type { MeasurementTrust } from '../api/types';
import { useAsync, useStore } from '../store';

const RANGE_OPTIONS: Array<{ value: AnalyticsRange; label: string }> = [
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: '90d', label: 'Last 90 days' },
];
type BreakdownView = WebDimension | 'conversion';
const DIMENSIONS: Array<{ value: BreakdownView; label: string }> = [
  { value: 'source', label: 'Sources' },
  { value: 'route', label: 'Pages' },
  { value: 'campaign', label: 'Campaigns' },
  { value: 'conversion', label: 'Conversions' },
  { value: 'country', label: 'Countries' },
  { value: 'device', label: 'Devices' },
];

export function WebAnalytics() {
  const { client, project, env } = useStore();
  const [range, setRange] = useState<AnalyticsRange>('30d');
  const [dimension, setDimension] = useState<BreakdownView>('source');
  const [selectedSession, setSelectedSession] = useState<WebSessionSummary | null>(null);
  const workspace = useAsync<(WebWorkspaceResult & { trust: WebTrustRead }) | null>(async () => {
    const metrics = await client!.metrics(project!, { status: 'active' });
    const metric = webPageMetric(metrics);
    if (!metric) return null;
    const base = {
      metric: metric.key,
      date_from: rangeDateFrom(range),
      filters: [],
      env,
    };
    const [overview, sessions, trend, trust] = await Promise.all([
      client!.operationalQuery<WebAnalyticsResult>(project!, {
        kind: 'web_analytics',
        ...base,
        dimensions: ['source', 'campaign', 'medium', 'route', 'device', 'browser', 'country'],
      }),
      client!.operationalQuery<WebSessionsResult>(project!, {
        kind: 'web_sessions',
        ...base,
        limit: 50,
      }),
      client!.query(project!, {
        kind: 'trend',
        metric: metric.key,
        date_from: rangeDateFrom(range),
        date_to: null,
        interval: 'day',
        filters: [],
        env,
      }).then((result) => {
        if (result.kind !== 'trend') throw new Error('Trend query returned an unexpected result kind');
        return result;
      }),
      readWebTrust(client!, project!, env, metric.key),
    ]);
    return { metric, overview, sessions, trend, trust };
  }, [project, env, range]);

  if (workspace.loading) return <WebAnalyticsSkeleton />;
  if (workspace.error) return <ErrorNote>{workspace.error}</ErrorNote>;
  if (!workspace.data) {
    return (
      <div className="space-y-5">
        <ScreenHeader range={range} onRange={setRange} />
        <Panel>
          <EmptyState
            headline="Web analytics is not configured"
            lead={`Activate ${WEB_PAGE_VIEW_METRIC} before reading canonical web traffic.`}
            action={<Button asChild variant="outline"><Link to="/measurement">Open measurement</Link></Button>}
          />
        </Panel>
      </div>
    );
  }

  const { metric, overview, sessions, trend, trust } = workspace.data;
  const spec = webTrendSpec(project!, env, metric.name, metric.purpose, overview, trend, trust);
  const breakdown = dimension === 'conversion' ? [] : overview.breakdowns[dimension] ?? [];
  const unavailableDimensions = overview.meta.unavailable_dimensions ?? {};
  const unavailable = dimension === 'conversion' ? null : unavailableDimensions[dimension];
  const routeAvailable = !unavailableDimensions.route;

  return (
    <div className="space-y-5">
      <ScreenHeader range={range} onRange={(value) => { setRange(value); setSelectedSession(null); }} />

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

      <div className="grid gap-3 border-y bg-card/45 px-4 py-3 text-sm sm:grid-cols-3">
        <Rate label="Measured coverage" value={overview.engagement.measured_session_coverage} />
        <Rate label="Engaged rate" value={overview.engagement.engaged_rate} />
        <Rate label="Bounce rate" value={overview.engagement.bounce_rate} />
      </div>

      <ManualVisualizationRenderer spec={spec} result={trend} />

      <AnswerCanvas>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3 sm:px-5">
          <h2 className="text-sm font-semibold">Traffic breakdown</h2>
          {overview.meta.truncated_dimensions.length > 0
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
        {dimension === 'conversion' ? (
          <div className="border-y border-dashed px-4 py-7 text-center">
            <div className="text-lg font-semibold">Choose a conversion to measure</div>
            <p className="mx-auto mt-1 max-w-lg text-sm text-muted-foreground">The current canonical web response does not include a conversion outcome, so Poolstatis will not display a zero.</p>
            <Button asChild variant="outline" className="mt-4 h-11"><Link to="/measurement">Open Definitions</Link></Button>
          </div>
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
        right={<span className="text-xs text-muted-foreground">{sessions.sessions.length} of {sessions.meta.total}</span>}
      >
        {sessions.sessions.length === 0 ? (
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
                {sessions.sessions.map((session) => (
                  <TableRow key={`${session.actor_id}:${session.session_id}`}>
                    <TableCell>
                      <Link
                        to={`/analyze/users/${encodeURIComponent(session.actor_id)}`}
                        className="font-mono text-xs text-primary hover:underline"
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
                          onClick={() => setSelectedSession(session)}
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
        {sessions.meta.truncated && (
          <p className="mt-3 text-xs text-muted-foreground">Showing the first 50 sessions for this exact period.</p>
        )}
      </Panel>

      {selectedSession && (
        <SessionDetail
          session={selectedSession}
          metric={metric.key}
          range={range}
          onClose={() => setSelectedSession(null)}
        />
      )}
    </div>
  );
}

function ScreenHeader({ range, onRange }: { range: AnalyticsRange; onRange: (range: AnalyticsRange) => void }) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="serif text-3xl sm:text-4xl">Web</h1>
        <p className="mt-1 text-sm text-muted-foreground">Traffic, pages, sources and supported conversions from canonical browser events.</p>
      </div>
      <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
        Period
        <Select value={range} onValueChange={(value) => onRange(value as AnalyticsRange)}>
          <SelectTrigger className="!h-11 w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            {RANGE_OPTIONS.map((item) => <SelectItem className="min-h-11" key={item.value} value={item.value}>{item.label}</SelectItem>)}
          </SelectContent>
        </Select>
      </label>
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
      <div className="h-11 w-56 animate-pulse rounded-control bg-muted" />
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => <div key={index} className="h-28 animate-pulse rounded-panel border bg-muted/70" />)}
      </div>
      <div className="h-80 animate-pulse rounded-dialog border bg-muted/60" />
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
  return trust.result.status === 'trusted' ? 'trusted' : 'partial';
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}
