import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, ChevronRight, Loader2, Search } from '@/components/icons';
import { useAsync, useStore } from '../store';
import { EmptyState, ErrorNote, Hint, Loading, Panel, RecoverableError, fmtNum } from '../components/ui';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { MeasurementContract, MeasurementTrust, Metric, PropertyDefinition, TrendResponse, WebAnalyticsDimension, WebAnalyticsResponse, WebSessionResponse, WebSessionsResponse } from '../api/types';

interface MetricTrustRow {
  metric: Metric;
  trust: MeasurementTrust | null;
  error: string | null;
}

interface PropertyCoverageRow {
  metric: Metric;
  property: string;
  coverage: number;
  status: 'missing' | PropertyDefinition['status'];
}

export function Measurement() {
  const { client, project, env } = useStore();
  const [proposingAttribution, setProposingAttribution] = useState(false);
  const [attributionError, setAttributionError] = useState<string | null>(null);
  const audit = useAsync(async () => {
    const [properties, identity, sources, metrics, contracts] = await Promise.all([
      client!.properties(project!),
      client!.actorLinks(project!, env),
      client!.sources(project!),
      client!.metrics(project!, { status: 'active' }),
      client!.contracts(project!),
    ]);
    const trust: MetricTrustRow[] = await Promise.all(metrics.map(async (metric) => {
      try {
        return {
          metric,
          trust: await client!.measurementTrust(project!, {
            metric_key: metric.key,
            env,
            since_days: 30,
            target_filters: [],
          }),
          error: null,
        };
      } catch (error) {
        return {
          metric,
          trust: null,
          error: error instanceof Error ? error.message : 'trust check failed',
        };
      }
    }));
    const acquisitionProperties = properties.filter((property) => property.scope === 'event' && property.key.startsWith('$utm_'));
    const propertyCoverage = (await Promise.all(metrics.flatMap((metric) => acquisitionProperties.map(async (property): Promise<PropertyCoverageRow | null> => {
      try {
        const result = await client!.measurementTrust(project!, {
          metric_key: metric.key,
          env,
          since_days: 30,
          target_filters: [{ property: property.key, op: 'is_set' }],
        });
        const coverage = result.properties.find((item) => item.key === property.key);
        return coverage ? { metric, property: property.key, coverage: coverage.coverage, status: coverage.status } : null;
      } catch { return null; }
    })))).filter((row): row is PropertyCoverageRow => row !== null);
    return { properties, identity, sources, trust, contracts, propertyCoverage };
  }, [project, env]);

  if (audit.loading) return <Loading what="checking measurement trust…" />;
  if (audit.error) return <RecoverableError onRetry={audit.reload}>{audit.error}</RecoverableError>;
  if (!audit.data) return null;
  const { properties, identity, sources, trust, contracts, propertyCoverage } = audit.data;
  const proposeAttribution = async () => {
    setProposingAttribution(true); setAttributionError(null);
    try { await client!.proposeAcquisitionProperties(project!); await audit.reload(); }
    catch (error) { setAttributionError(error instanceof Error ? error.message : 'could not propose acquisition properties'); }
    finally { setProposingAttribution(false); }
  };

  return <div className="space-y-4">
    <Panel title="Measurement" right={<span className="text-xs text-muted-foreground">server evidence · {env}</span>}>
      <p className="max-w-3xl text-sm text-muted-foreground">Review what is decision-ready, then open only the metric that needs action.</p>
    </Panel>

    <TrustOverview rows={trust} properties={properties.length} activeLinks={identity.links.filter((link) => link.status === 'active').length} onRefresh={audit.reload} />

    <WebAnalyticsPanel metrics={trust.map((row) => row.metric)} env={env} onSetup={audit.reload} />

    <AcquisitionPanel metrics={trust.map((row) => row.metric)} env={env} />

    <ContractsPanel contracts={contracts} />

    <Panel title={<>Property meanings <span className="ml-2 font-sans text-sm font-normal text-muted-foreground">{properties.length}</span></>} right={<Button variant="outline" size="sm" onClick={proposeAttribution} disabled={proposingAttribution}>{proposingAttribution ? 'Proposing…' : 'Propose acquisition UTM properties'}</Button>}>
      <p className="mb-4 max-w-3xl text-sm text-muted-foreground">Browser acquisition setup adds only the five canonical UTM definitions as proposed. Session landing attribution is an association, not causal campaign credit.</p>
      {attributionError && <div className="mb-4"><ErrorNote>{attributionError}</ErrorNote></div>}
      {properties.length === 0 ? <p className="text-sm text-muted-foreground">No decision properties are registered yet.</p> : <div className="overflow-x-auto">
        <Table><TableHeader><TableRow><TableHead>Property</TableHead><TableHead>Meaning</TableHead><TableHead>Type</TableHead><TableHead>Trust</TableHead><TableHead>Coverage</TableHead><TableHead>Source</TableHead></TableRow></TableHeader>
          <TableBody>{properties.map((property) => <TableRow key={`${property.scope}:${property.key}`}>
            <TableCell><code className="text-xs">{property.scope}.{property.key}</code></TableCell>
            <TableCell className="max-w-lg text-sm text-muted-foreground">{property.purpose}</TableCell>
            <TableCell><Badge variant="outline" className="font-normal">{property.value_type}</Badge></TableCell>
            <TableCell><PropertyTrustBadge status={property.status} /></TableCell>
            <TableCell className="min-w-44 text-xs text-muted-foreground"><PropertyCoverage property={property.key} rows={propertyCoverage} /></TableCell>
            <TableCell className="text-xs text-muted-foreground">{property.source}</TableCell>
          </TableRow>)}</TableBody>
        </Table>
      </div>}
    </Panel>

    <Panel title="Identity links" right={<span className="text-xs text-muted-foreground">reversible · append-only audit</span>}>
      {identity.links.length === 0 ? <p className="text-sm text-muted-foreground">No anonymous-to-identified links have been recorded for <code>{env}</code>.</p> : <div className="overflow-x-auto">
        <Table><TableHeader><TableRow><TableHead>Source actor</TableHead><TableHead>Stable actor</TableHead><TableHead>Status</TableHead><TableHead>Created by</TableHead><TableHead>Updated</TableHead></TableRow></TableHeader>
          <TableBody>{identity.links.map((link) => <TableRow key={link.id}>
            <TableCell><code className="text-xs">{link.source_distinct_id}</code></TableCell>
            <TableCell><code className="text-xs">{link.target_distinct_id}</code></TableCell>
            <TableCell><Badge variant={link.status === 'active' ? 'default' : 'secondary'}>{link.status}</Badge></TableCell>
            <TableCell className="text-xs text-muted-foreground">{link.created_by}</TableCell>
            <TableCell className="text-xs text-muted-foreground">{formatDate(link.revoked_at ?? link.created_at)}</TableCell>
          </TableRow>)}</TableBody>
        </Table>
      </div>}
      <div className="mt-4 border-t pt-4 text-xs text-muted-foreground">{identity.audit.length} audit {identity.audit.length === 1 ? 'entry' : 'entries'} preserved in this environment.</div>
    </Panel>

    <Panel title="Data sources" right={<span className="text-xs text-muted-foreground">bounded read-only capabilities</span>}>
      {sources.length === 0 ? <p className="text-sm text-muted-foreground">Native ingest is the current data path. Configure PostHog through MCP or the Platform API when raw data should remain external.</p> : <div className="space-y-3">
        {sources.map((source) => <div key={source.id} className="rounded-md border bg-muted/20 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3"><div><div className="font-medium">{source.name}</div><div className="mt-1 text-xs text-muted-foreground"><code>{source.provider}</code> · project {source.external_project_id} · {source.host}</div></div><SourceBadge status={source.status} /></div>
          <div className="mt-3 flex flex-wrap gap-1.5">{Object.entries(source.capabilities).map(([capability, supported]) => <Hint key={capability} label={supported ? `${capability} is supported by the bounded adapter.` : `${capability} is explicitly unsupported; Poolstatis will return a capability error.`}><Badge variant={supported ? 'outline' : 'secondary'} className="cursor-help font-normal">{capability} · {supported ? 'yes' : 'no'}</Badge></Hint>)}</div>
          {source.last_error && <div className="mt-3 text-xs text-destructive">{source.last_error}</div>}
        </div>)}
      </div>}
    </Panel>
  </div>;
}

const webDimensions: WebAnalyticsDimension[] = ['country', 'device', 'browser', 'os', 'source'];
const webDimensionLabels: Record<WebAnalyticsDimension, string> = {
  country: 'Country',
  device: 'Device',
  browser: 'Browser',
  os: 'OS',
  language: 'Language',
  timezone: 'Timezone',
  source: 'Source',
};
const collapsedBreakdownRows = 8;
const maxBreakdownRows = 50;

function WebAnalyticsPanel({ metrics, env, onSetup }: { metrics: Metric[]; env: string; onSetup: () => void }) {
  const { client, project } = useStore();
  const metric = metrics.find((item) => item.key === 'web_page_views' && item.type === 'count');
  const [period, setPeriod] = useState('30');
  const [result, setResult] = useState<WebAnalyticsResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [setupBusy, setSetupBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const setup = async () => {
    setSetupBusy(true); setError(null);
    try { await client!.proposeBrowserAnalytics(project!); onSetup(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'could not propose browser analytics'); }
    finally { setSetupBusy(false); }
  };
  const run = async () => {
    if (!metric) return;
    setBusy(true); setError(null); setResult(null);
    try {
      setResult(await client!.webAnalytics(project!, {
        metric: metric.key, date_from: `-${period}d`, dimensions: webDimensions, env,
      }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'could not query web analytics');
    } finally { setBusy(false); }
  };
  return <Panel title="Web analytics" right={<span className="text-xs text-muted-foreground">consented browser context · {env}</span>}>
    <p className="max-w-3xl text-sm text-muted-foreground">How many visited, where they came from, and what they used.</p>
    <div className="mt-4 flex flex-wrap items-end gap-2">
      <div className="space-y-1.5"><label className="text-xs font-medium text-muted-foreground">Period</label><Select value={period} onValueChange={(value) => { setPeriod(value); setResult(null); }}><SelectTrigger aria-label="Web analytics period" className="w-28"><SelectValue /></SelectTrigger><SelectContent>{['7', '30', '90'].map((days) => <SelectItem key={days} value={days}>{days} days</SelectItem>)}</SelectContent></Select></div>
      {metric
        ? <Button onClick={run} disabled={busy}>{busy && <Loader2 className="size-4 animate-spin" />}Run traffic summary</Button>
        : <Button variant="outline" onClick={setup} disabled={setupBusy}>{setupBusy ? 'Proposing…' : 'Propose browser analytics'}</Button>}
    </div>
    {!metric && <div className="mt-4"><EmptyState headline="Traffic summary unavailable" lead="propose the canonical bundle, review it in Registry, then activate web_page_views" /></div>}
    {error && <div className="mt-4"><ErrorNote>{error}</ErrorNote></div>}
    {busy && <div className="mt-4"><Loading what="loading traffic summary…" /></div>}
    {result && result.summary.page_views === 0 && <div className="mt-4"><EmptyState headline="No page views in this window" lead="no zero was estimated; verify consent, SDK capture and the active page-view metric" /></div>}
    {result && result.summary.page_views > 0 && <>
      <WebAnalyticsResults result={result} />
      <WebSessionsExplorer metric={metric!.key} period={period} env={env} />
    </>}
  </Panel>;
}

function WebAnalyticsResults({ result }: { result: WebAnalyticsResponse }) {
  const [dimension, setDimension] = useState<WebAnalyticsDimension>('country');
  const [expanded, setExpanded] = useState(false);
  const [search, setSearch] = useState('');
  const selectDimension = (value: string) => {
    setDimension(value as WebAnalyticsDimension);
    setExpanded(false);
    setSearch('');
  };
  return <div className="mt-4 space-y-4" aria-live="polite">
    <div className="grid gap-px overflow-hidden rounded-md border bg-border sm:grid-cols-3">
      {[
        ['Visitors', result.summary.visitors, result.meta.definitions.visitors],
        ['Sessions', result.summary.sessions, result.meta.definitions.sessions],
        ['Page views', result.summary.page_views, result.meta.definitions.page_views],
      ].map(([label, value, definition]) => <div key={String(label)} className="min-w-0 bg-card p-4">
        <Hint label={definition}>
          <button type="button" className="rounded-sm text-xs text-muted-foreground underline decoration-dotted underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{label}</button>
        </Hint>
        <div className="serif mt-1 text-2xl tabular-nums">{fmtNum(Number(value))}</div>
      </div>)}
    </div>
    <WebEngagementSummary result={result} />
    <RankedDimensionExplorer
      result={result}
      dimension={dimension}
      expanded={expanded}
      search={search}
      onDimensionChange={selectDimension}
      onExpandedChange={setExpanded}
      onSearchChange={setSearch}
    />
  </div>;
}

function WebEngagementSummary({ result }: { result: WebAnalyticsResponse }) {
  const engagement = result.engagement;
  const coverage = engagement.timed_page_coverage === null
    ? '—'
    : `${Math.round(engagement.timed_page_coverage * 100)}%`;
  return <section className="rounded-md border" aria-labelledby="engagement-summary-title">
    <div className="border-b px-4 py-3">
      <h3 id="engagement-summary-title" className="text-sm font-medium">Measured engagement</h3>
      <p className="mt-0.5 text-xs text-muted-foreground">
        Foreground time counts only visible, focused intervals. Bounce is unknown when page timing is incomplete.
      </p>
    </div>
    <div className="grid gap-px bg-border sm:grid-cols-2 lg:grid-cols-4">
      {[
        ['Engaged', `${fmtNum(engagement.engaged_sessions)} / ${fmtNum(engagement.measured_sessions)}`, result.meta.definitions.engaged_sessions],
        ['Bounces', fmtNum(engagement.bounce_sessions), result.meta.definitions.bounce_sessions],
        ['Foreground time', formatEngagementMs(engagement.foreground_ms), result.meta.definitions.foreground_ms],
        ['Timed page coverage', coverage, `${fmtNum(engagement.timed_page_views)} of ${fmtNum(engagement.total_page_views)} page views have timing evidence.`],
      ].map(([label, value, definition]) => <div key={label} className="min-w-0 bg-card p-4">
        <Hint label={definition}><span className="text-xs text-muted-foreground">{label}</span></Hint>
        <div className="serif mt-1 text-xl tabular-nums">{value}</div>
      </div>)}
    </div>
    {engagement.incomplete_sessions > 0 && <p className="border-t px-4 py-3 text-xs text-muted-foreground">
      {fmtNum(engagement.incomplete_sessions)} incomplete {engagement.incomplete_sessions === 1 ? 'session is' : 'sessions are'} excluded from bounce classification.
    </p>}
  </section>;
}

function WebSessionsExplorer({ metric, period, env }: { metric: string; period: string; env: string }) {
  const { client, project } = useStore();
  const [sessions, setSessions] = useState<WebSessionsResponse | null>(null);
  const [detail, setDetail] = useState<WebSessionResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = async () => {
    setBusy(true); setError(null); setDetail(null);
    try {
      setSessions(await client!.webSessions(project!, {
        metric, date_from: `-${period}d`, env, limit: 20,
      }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'could not load sessions');
    } finally { setBusy(false); }
  };
  const inspect = async (sessionId: string) => {
    setBusy(true); setError(null);
    try {
      setDetail(await client!.webSession(project!, {
        metric, session_id: sessionId, date_from: `-${period}d`, env,
      }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'could not load session');
    } finally { setBusy(false); }
  };
  return <section className="mt-4 rounded-md border" aria-labelledby="web-sessions-title">
    <div className="flex flex-wrap items-start justify-between gap-3 border-b px-4 py-3">
      <div>
        <h3 id="web-sessions-title" className="text-sm font-medium">Session engagement</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">Browser-tab sessions with bounded page paths and timing evidence — not video replay.</p>
      </div>
      <Button variant="outline" size="sm" onClick={load} disabled={busy}>
        {busy && <Loader2 className="size-4 animate-spin" />}Load recent sessions
      </Button>
    </div>
    {error && <div className="p-4"><ErrorNote>{error}</ErrorNote></div>}
    {sessions && sessions.sessions.length === 0 && <div className="p-4"><EmptyState headline="No measured sessions" lead="no matching accepted page views exist in this period" /></div>}
    {sessions && sessions.sessions.length > 0 && <div className="overflow-x-auto">
      <Table>
        <TableHeader><TableRow><TableHead>Started</TableHead><TableHead>Pages</TableHead><TableHead>Foreground</TableHead><TableHead>Span</TableHead><TableHead>Classification</TableHead><TableHead><span className="sr-only">Action</span></TableHead></TableRow></TableHeader>
        <TableBody>{sessions.sessions.map((session) => <TableRow key={session.session_id}>
          <TableCell className="whitespace-nowrap text-xs">{formatDate(session.started_at)}</TableCell>
          <TableCell className="tabular-nums">{session.page_views}</TableCell>
          <TableCell className="whitespace-nowrap tabular-nums">{formatEngagementMs(session.foreground_ms)}</TableCell>
          <TableCell className="whitespace-nowrap tabular-nums">{formatEngagementMs(session.session_span_ms)}</TableCell>
          <TableCell><div className="flex flex-wrap gap-1">
            <Badge variant={session.engaged ? 'default' : 'secondary'}>
              {session.engaged ? 'Engaged' : session.engaged === false ? 'Not engaged' : 'Unknown'}
            </Badge>
            <Badge variant="outline">{session.complete ? 'Complete' : 'Incomplete'}</Badge>
          </div></TableCell>
          <TableCell className="text-right"><Button variant="ghost" size="sm" onClick={() => inspect(session.session_id)}>Inspect</Button></TableCell>
        </TableRow>)}</TableBody>
      </Table>
      <p className="border-t px-4 py-3 text-xs text-muted-foreground">
        Showing {sessions.sessions.length} of {sessions.meta.total} sessions{sessions.meta.truncated ? ' · bounded result' : ''}.
      </p>
    </div>}
    {detail?.summary && <div className="border-t p-4">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="text-sm font-medium">Session pages</h4>
        <span className="text-xs text-muted-foreground">
          {detail.pages.length} of {detail.meta.total_pages} page {detail.meta.total_pages === 1 ? 'view' : 'views'}
          {detail.meta.truncated ? ' · bounded result' : ''}
        </span>
      </div>
      <ol className="space-y-2">{detail.pages.map((page) => <li key={page.page_view_id} className="grid gap-1 rounded-md border p-3 text-sm sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center">
        <code className="min-w-0 truncate text-xs">{page.path}</code>
        <span className="text-xs tabular-nums text-muted-foreground">{page.foreground_ms === null ? 'Timing unavailable' : formatEngagementMs(page.foreground_ms)}</span>
        <Badge variant={page.complete ? 'outline' : 'secondary'}>{page.complete ? 'Complete' : page.timed ? 'Timed, incomplete' : 'No timing'}</Badge>
      </li>)}</ol>
    </div>}
  </section>;
}

function formatEngagementMs(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return '—';
  const seconds = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes > 0 ? `${minutes}m ${remainder}s` : `${remainder}s`;
}

function RankedDimensionExplorer({
  result, dimension, expanded, search, onDimensionChange, onExpandedChange, onSearchChange,
}: {
  result: WebAnalyticsResponse;
  dimension: WebAnalyticsDimension;
  expanded: boolean;
  search: string;
  onDimensionChange: (value: string) => void;
  onExpandedChange: (value: boolean) => void;
  onSearchChange: (value: string) => void;
}) {
  const sourceRows = result.breakdowns[dimension] ?? [];
  const rows = [...sourceRows]
    .sort((left, right) => right.page_views - left.page_views || left.value.localeCompare(right.value))
    .slice(0, maxBreakdownRows);
  const truncated = result.meta.truncated_dimensions.includes(dimension) || sourceRows.length > maxBreakdownRows;
  const canExpand = rows.length > collapsedBreakdownRows;
  const normalizedSearch = search.trim().toLocaleLowerCase();
  const visibleRows = (expanded ? rows : rows.slice(0, collapsedBreakdownRows))
    .filter((row) => !normalizedSearch || row.value.toLocaleLowerCase().includes(normalizedSearch));
  const returnedTail = Math.max(0, rows.length - collapsedBreakdownRows);
  const resultLabel = expanded
    ? `${visibleRows.length} of ${rows.length} returned groups`
    : `${Math.min(collapsedBreakdownRows, rows.length)} of ${rows.length} returned groups`;

  return <section className="min-w-0 overflow-hidden rounded-md border" aria-labelledby="web-breakdown-title">
    <div className="flex min-w-0 flex-wrap items-start justify-between gap-3 border-b px-4 py-3">
      <div className="min-w-0">
        <h3 id="web-breakdown-title" className="text-sm font-medium">Breakdown</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">Ranked by page views · share of all page views</p>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        {result.meta.country_attribution && <a
          href={result.meta.country_attribution.url}
          target="_blank"
          rel="noreferrer"
          className="rounded-sm text-xs text-muted-foreground underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >{result.meta.country_attribution.label}</a>}
        <Hint label={result.meta.privacy}>
          <button type="button" className="rounded-sm text-xs text-muted-foreground underline decoration-dotted underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Privacy</button>
        </Hint>
      </div>
    </div>
    <Tabs value={dimension} onValueChange={onDimensionChange} className="min-w-0 gap-0">
      <div className="border-b p-3 sm:hidden">
        <Select value={dimension} onValueChange={onDimensionChange}>
          <SelectTrigger aria-label="Breakdown dimension" className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>{webDimensions.map((item) => <SelectItem key={item} value={item}>{webDimensionLabels[item]}</SelectItem>)}</SelectContent>
        </Select>
      </div>
      <div className="hidden min-w-0 border-b px-3 pt-2 sm:block">
        <TabsList variant="line" aria-label="Breakdown dimension" className="grid h-10 w-full grid-cols-5">
          {webDimensions.map((item) => <TabsTrigger key={item} value={item}>{webDimensionLabels[item]}</TabsTrigger>)}
        </TabsList>
      </div>
      <TabsContent value={dimension} className="mt-0">
      {expanded && rows.length > 12 && <div className="border-b p-3">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          aria-label={`Search ${webDimensionLabels[dimension].toLowerCase()} groups`}
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder={`Search ${rows.length} returned groups`}
          className="pl-8"
        />
      </div>
    </div>}
    <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-3 border-b bg-muted/30 px-4 py-2 text-xs text-muted-foreground" aria-hidden="true">
      <span>{webDimensionLabels[dimension]}</span><span>Views</span><span className="w-12 text-right">Share</span>
    </div>
    {rows.length === 0 ? <div className="px-4 py-10 text-center text-sm text-muted-foreground" role="status">No {webDimensionLabels[dimension].toLowerCase()} data in this window.</div>
      : visibleRows.length === 0 ? <div className="px-4 py-10 text-center text-sm text-muted-foreground" role="status">No matching groups.</div>
        : <div
          className={expanded ? 'max-h-96 divide-y overflow-y-auto overscroll-contain' : 'divide-y'}
          tabIndex={expanded ? 0 : undefined}
          role="list"
          aria-label={`${webDimensionLabels[dimension]} ranked by page views`}
        >
          {visibleRows.map((row) => {
            const label = row.value.trim() && row.value.toLocaleLowerCase() !== 'unknown' ? row.value : 'Unknown';
            const percentage = Number.isFinite(row.percentage)
              ? Math.max(0, Math.min(100, row.percentage))
              : 0;
            return <div key={row.value} className="relative isolate grid min-w-0 grid-cols-[minmax(0,1fr)_auto_auto] gap-3 overflow-hidden px-4 py-2.5 text-sm" role="listitem">
              <div className="absolute inset-y-1 left-0 -z-10 rounded-r-sm bg-primary/10" style={{ width: `${percentage}%` }} aria-hidden="true" />
              <span className="min-w-0 truncate font-medium" title={label}>{label}</span>
              <span className="tabular-nums">{fmtNum(row.page_views)}</span>
              <span className="w-12 text-right text-xs tabular-nums text-muted-foreground">{percentage}%</span>
              <span className="sr-only">{fmtNum(row.visitors)} visitors, {fmtNum(row.sessions)} sessions</span>
            </div>;
          })}
        </div>}
    <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 border-t px-4 py-3">
      <p className="min-w-0 text-xs text-muted-foreground">
        Showing {resultLabel}
        {!expanded && returnedTail > 0 ? ` · ${returnedTail} more returned` : ''}
        {truncated ? ` · at least 1 more beyond the top ${maxBreakdownRows}` : ''}
      </p>
      {canExpand && <Button variant="outline" size="sm" onClick={() => {
        onExpandedChange(!expanded);
        if (expanded) onSearchChange('');
      }}>{expanded ? 'Show top 8' : 'View all'}</Button>}
    </div>
      </TabsContent>
    </Tabs>
  </section>;
}

function TrustOverview({ rows, properties, activeLinks, onRefresh }: {
  rows: MetricTrustRow[]; properties: number; activeLinks: number; onRefresh: () => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const trusted = rows.filter((row) => row.trust?.status === 'trusted').length;
  const unavailable = rows.filter((row) => Boolean(row.error)).length;
  const untrusted = rows.length - trusted - unavailable;
  return <Panel title="Decision readiness" right={<Button variant="outline" size="sm" onClick={onRefresh}>Refresh evidence</Button>}>
    <div className="grid gap-px overflow-hidden rounded-md border bg-border sm:grid-cols-3" aria-live="polite">
      {[
        [`${trusted} trusted`, 'No trust blockers'],
        [`${untrusted} untrusted`, 'Review the first blocker'],
        [`${unavailable} unavailable`, 'Retry or inspect the source'],
      ].map(([value, label]) => <div key={value} className="bg-card p-4"><div className="serif text-2xl">{value}</div><div className="mt-1 text-xs text-muted-foreground">{label}</div></div>)}
    </div>
    <div className="mt-3 flex flex-wrap gap-2 text-xs text-muted-foreground">
      <Badge variant="outline">{rows.length} active metrics</Badge>
      <Badge variant="outline">{properties} properties</Badge>
      <Badge variant="outline">{activeLinks} active identity links</Badge>
    </div>
    {rows.length === 0 ? <div className="mt-4"><EmptyState headline="Nothing to assess" lead="activate a proposed metric in Registry first" /></div> : (
      <div className="mt-4 divide-y rounded-md border">
        {rows.map(({ metric, trust: result, error }) => {
          const expanded = open === metric.key;
          const finding = result?.blockers[0] ?? result?.warnings[0];
          return <section key={metric.key}>
            <div className="grid min-w-0 gap-3 p-4 md:grid-cols-[minmax(12rem,1.4fr)_auto_minmax(12rem,1fr)_auto] md:items-center">
              <div className="min-w-0"><div className="font-medium break-words">{metric.name}</div><code className="text-xs text-muted-foreground break-all">{metric.key}</code></div>
              <TrustBadge trusted={result?.status === 'trusted'} unavailable={Boolean(error)} />
              <div className="text-xs text-muted-foreground">
                {result ? <><div>{fmtNum(result.primary_metric.observed_events)} observations</div><div>{fmtNum(result.primary_metric.observed_actors)} actors · {pct(result.primary_metric.registered_coverage)} registered</div></> : 'Evidence unavailable'}
              </div>
              <Button variant="ghost" size="sm" aria-expanded={expanded} aria-controls={`trust-${metric.key}`} aria-label={`Review ${metric.name}`} onClick={() => setOpen(expanded ? null : metric.key)}>
                {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}Review
              </Button>
            </div>
            {expanded && <div id={`trust-${metric.key}`} className="grid gap-3 border-t bg-muted/20 p-4 md:grid-cols-2">
              <div><div className="text-xs font-medium text-muted-foreground">Purpose</div><p className="mt-1 text-sm">{metric.purpose}</p></div>
              <div>
                <div className="text-xs font-medium text-muted-foreground">{error ? 'Error' : finding ? 'Next action' : 'Status'}</div>
                {error ? <p className="mt-1 text-sm text-destructive">{error}</p> : finding ? <><p className="mt-1 text-sm">{finding.message}</p><p className="mt-1 text-xs text-muted-foreground">Next: {finding.next_action}</p></> : <p className="mt-1 text-sm text-emerald-600">No trust blockers in this window.</p>}
              </div>
            </div>}
          </section>;
        })}
      </div>
    )}
  </Panel>;
}

type AcquisitionDimension = '$utm_source' | '$utm_medium' | '$utm_campaign' | '$utm_term' | '$utm_content';
type AcquisitionResult = Record<AcquisitionDimension, TrendResponse>;

function AcquisitionPanel({ metrics, env }: { metrics: Metric[]; env: string }) {
  const { client, project } = useStore();
  const eligible = useMemo(() => metrics.filter((metric) => metric.status === 'active' && metric.type === 'count'), [metrics]);
  const preferred = eligible.find((metric) => metric.category === 'acquisition') ?? eligible[0];
  const [metricKey, setMetricKey] = useState(preferred?.key ?? '');
  const [period, setPeriod] = useState('30');
  const [result, setResult] = useState<AcquisitionResult | null>(null);
  const [details, setDetails] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selected = eligible.find((metric) => metric.key === metricKey) ?? preferred;
  const run = async () => {
    if (!selected) return;
    setBusy(true); setError(null); setResult(null);
    try {
      const base = { metric: selected.key, date_from: `-${period}d`, interval: 'day' as const, env };
      const dimensions: AcquisitionDimension[] = details
        ? ['$utm_source', '$utm_medium', '$utm_campaign', '$utm_term', '$utm_content']
        : ['$utm_source', '$utm_medium', '$utm_campaign'];
      const responses = await Promise.all(dimensions.map((property) => client!.trend(project!, { ...base, breakdown: { property } })));
      setResult(Object.fromEntries(dimensions.map((dimension, index) => [dimension, responses[index]])) as AcquisitionResult);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'could not query acquisition breakdowns');
    } finally { setBusy(false); }
  };
  const event = selected ? String((selected.source as Record<string, unknown>).event ?? '') : '';
  return <Panel title="Acquisition / UTM" right={<span className="text-xs text-muted-foreground">registered metric query · {env}</span>}>
    <div className="flex flex-wrap items-end gap-2">
      <div className="min-w-52 flex-1 space-y-1.5"><label className="text-xs font-medium text-muted-foreground">Count metric</label><Select value={selected?.key ?? ''} onValueChange={(value) => { setMetricKey(value); setResult(null); }} disabled={eligible.length === 0}><SelectTrigger aria-label="Acquisition metric"><SelectValue placeholder="Choose an active count metric" /></SelectTrigger><SelectContent>{eligible.map((metric) => <SelectItem key={metric.key} value={metric.key}>{metric.name} · {metric.key}</SelectItem>)}</SelectContent></Select></div>
      <div className="space-y-1.5"><label className="text-xs font-medium text-muted-foreground">Period</label><Select value={period} onValueChange={(value) => { setPeriod(value); setResult(null); }}><SelectTrigger aria-label="Acquisition period" className="w-28"><SelectValue /></SelectTrigger><SelectContent>{['7', '30', '90'].map((days) => <SelectItem key={days} value={days}>{days} days</SelectItem>)}</SelectContent></Select></div>
      <Button onClick={run} disabled={!selected || busy}>{busy && <Loader2 className="size-4 animate-spin" />}Run UTM report</Button>
    </div>
    <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
      <button className="underline underline-offset-2 hover:text-foreground" aria-expanded={details} onClick={() => { setDetails((value) => !value); setResult(null); }}>{details ? 'Hide term and content' : 'Include term and content'}</button>
      {event && <Button variant="link" size="sm" asChild className="h-auto p-0"><Link to={`/data?tab=events&event=${encodeURIComponent(event)}`}>Open raw events</Link></Button>}
    </div>
    {eligible.length === 0 && <div className="mt-4"><EmptyState headline="No reportable count metric" lead="activate a count metric whose source event carries canonical UTM properties" /></div>}
    {busy && <div className="mt-4" role="status" aria-live="polite">Loading canonical UTM breakdowns…</div>}
    {error && <div className="mt-4"><ErrorNote>{error}. Check that the metric uses native events and that landing ingest is not blocked by CORS.</ErrorNote></div>}
    {result && <AcquisitionResults result={result} />}
  </Panel>;
}

function AcquisitionResults({ result }: { result: AcquisitionResult }) {
  const dimensions = Object.entries(result) as Array<[AcquisitionDimension, TrendResponse]>;
  const hasValues = dimensions.some(([, response]) => response.series.length > 0);
  if (!hasValues) return <div className="mt-4"><EmptyState headline="No attributed events in this window" lead="check raw events, metric source, and landing CORS; zero is preserved, not estimated" /></div>;
  return <div className="mt-4 grid gap-3 lg:grid-cols-3" aria-live="polite">
    {dimensions.map(([dimension, response]) => {
      const rows = aggregateBreakdown(response);
      const total = rows.reduce((sum, row) => sum + row.value, 0);
      return <div key={dimension} className="min-w-0 rounded-md border">
        <div className="border-b px-3 py-2"><code className="text-xs">{dimension}</code></div>
        <div className="divide-y">{rows.length === 0 ? <div className="p-3 text-xs text-muted-foreground">No values</div> : rows.slice(0, 6).map((row) => <div key={row.label} className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-2 px-3 py-2 text-sm"><span className="truncate" title={row.label}>{row.label}</span><span className="tabular-nums">{fmtNum(row.value)}</span><span className="w-10 text-right text-xs text-muted-foreground">{pct(total ? row.value / total : 0)}</span></div>)}</div>
      </div>;
    })}
  </div>;
}

function aggregateBreakdown(response: TrendResponse) {
  const values = new Map<string, number>();
  response.series.forEach((point) => {
    const raw = point.breakdown_value ?? '(none)';
    const label = raw === '(none)' ? 'Direct / unknown' : raw === '$other' ? 'Other' : raw;
    values.set(label, (values.get(label) ?? 0) + point.value);
  });
  return [...values.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
}

function PropertyCoverage({ property, rows }: { property: string; rows: PropertyCoverageRow[] }) {
  const coverage = rows.filter((row) => row.property === property);
  if (coverage.length === 0) return <span>Not assessed</span>;
  return <div className="space-y-1">{coverage.map((row) => <div key={row.metric.key}><code>{row.metric.key}</code> · {pct(row.coverage)}</div>)}</div>;
}

function ContractsPanel({ contracts }: { contracts: MeasurementContract[] }) {
  const { client, project } = useStore();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const download = async () => {
    setBusy(true); setError(null);
    try {
      const exported = await client!.exportContracts(project!);
      const url = URL.createObjectURL(new Blob([exported.yaml], { type: 'text/yaml' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = exported.filename;
      link.click();
      URL.revokeObjectURL(url);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'could not export measurement contracts');
    } finally { setBusy(false); }
  };
  return <Panel title={<>Measurement contracts <span className="ml-2 font-sans text-sm font-normal text-muted-foreground">{contracts.length}</span></>} right={<Button variant="outline" size="sm" onClick={download} disabled={busy || contracts.length === 0}>{busy ? 'Exporting…' : 'Export poolstatis.yml'}</Button>}>
    <p className="mb-4 max-w-3xl text-sm text-muted-foreground">Repository-owned hypotheses define what a release is expected to change, which metric decides it, and which guardrails can stop it.</p>
    {contracts.length === 0 ? <p className="text-sm text-muted-foreground">No contracts have been applied. Validate and apply <code>poolstatis.yml</code> through MCP or the Platform API.</p> : <div className="overflow-x-auto">
      <Table><TableHeader><TableRow><TableHead>Contract</TableHead><TableHead>Hypothesis</TableHead><TableHead>Decision rule</TableHead><TableHead>Owner</TableHead><TableHead>Status</TableHead></TableRow></TableHeader>
        <TableBody>{contracts.map((contract) => <TableRow key={contract.id}>
          <TableCell className="min-w-48"><div className="font-medium">{contract.name}</div><code className="text-xs text-muted-foreground">{contract.key}</code><div className="mt-1 text-xs text-muted-foreground">revision {contract.revision}</div></TableCell>
          <TableCell className="min-w-72 max-w-lg text-sm text-muted-foreground">{contract.business_hypothesis}</TableCell>
          <TableCell className="min-w-64 text-xs"><div><code>{contract.primary_metric_key}</code> must {contract.expected_direction.replaceAll('_', ' ')}</div><div className="mt-1 text-muted-foreground">{contract.minimum_sample_size} actors · {contract.observation_window_days} days</div>{contract.guardrail_metric_keys.length > 0 && <div className="mt-1 text-muted-foreground">Guardrails: {contract.guardrail_metric_keys.join(', ')}</div>}</TableCell>
          <TableCell className="text-sm">{contract.decision_owner}</TableCell>
          <TableCell><Badge variant={contract.status === 'active' ? 'default' : 'outline'}>{contract.status}</Badge></TableCell>
        </TableRow>)}</TableBody>
      </Table>
    </div>}
    {error && <div className="mt-3"><ErrorNote>{error}</ErrorNote></div>}
  </Panel>;
}

function TrustBadge({ trusted, unavailable }: { trusted: boolean; unavailable: boolean }) {
  if (unavailable) return <Badge variant="secondary">unavailable</Badge>;
  return <Badge variant={trusted ? 'default' : 'destructive'}>{trusted ? 'trusted' : 'untrusted'}</Badge>;
}

function PropertyTrustBadge({ status }: { status: 'proposed' | 'trusted' | 'untrusted' }) {
  return <Hint label={status === 'trusted' ? 'Meaning and type were explicitly reviewed.' : status === 'proposed' ? 'Awaiting explicit semantic review.' : 'Known unsafe for decision filters.'}><Badge variant={status === 'trusted' ? 'default' : status === 'untrusted' ? 'destructive' : 'outline'} className="cursor-help">{status}</Badge></Hint>;
}

function SourceBadge({ status }: { status: 'configured' | 'verified' | 'error' | 'disabled' }) {
  return <Badge variant={status === 'verified' ? 'default' : status === 'error' ? 'destructive' : 'outline'}>{status}</Badge>;
}

function pct(value: number) {
  return `${Math.round(value * 100)}%`;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}
