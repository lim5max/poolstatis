import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Search } from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { EmptyState, ErrorNote, Loading, fmtNum } from '@/components/ui';
import { AnswerCanvas } from '@/components/analytics';
import { DisclosureSummary } from '@/components/disclosure';
import {
  actorStatusLabel,
  type ActorOrderReason,
  rangeDateFrom,
  type ActorIdentityStatus,
  type ActorOrder,
  type ActorsResult,
  type AnalyticsRange,
} from '../analysis/operations';
import type { Metric } from '../api/types';
import { useAsync, useStore } from '../store';

const PAGE_LIMIT = 50;

interface InterestingMetricSelection {
  client: ReturnType<typeof useStore>['client'];
  project: string | null;
  env: string;
  metric: string;
}

export function Users() {
  const { client, project, env } = useStore();
  const [range, setRange] = useState<AnalyticsRange>('30d');
  const [order, setOrder] = useState<ActorOrder>('last_seen_desc');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [activityMetric, setActivityMetric] = useState('');
  const [interestingSelection, setInterestingSelection] = useState<InterestingMetricSelection | null>(null);
  const [cursorStack, setCursorStack] = useState<Array<string | null>>([null]);
  const page = cursorStack.length - 1;
  const cursor = cursorStack[page] ?? undefined;
  const registryScope = useMemo(() => ({ client, project, env }), [client, project, env]);
  const metrics = useAsync<{ scope: typeof registryScope; result: Metric[] }>(async () => ({
    scope: registryScope,
    result: await client!.metrics(project!, { status: 'active' }),
  }), [registryScope]);
  const interestingMetric = interestingSelection
    && interestingSelection.client === client
    && interestingSelection.project === project
    && interestingSelection.env === env
    ? interestingSelection.metric
    : '';
  const queryOrder: ActorOrder = interestingMetric ? 'interesting_desc' : order;
  const actorScopeKey = JSON.stringify([
    project, env, range, queryOrder, search, activityMetric, interestingMetric, cursor ?? null,
  ]);
  const actorScope = useMemo(() => ({ client, key: actorScopeKey }), [client, actorScopeKey]);
  const actors = useAsync<{ scope: typeof actorScope; result: ActorsResult }>(async () => ({
    scope: actorScope,
    result: await client!.operationalQuery<ActorsResult>(project!, {
      kind: 'actors',
      env,
      from: rangeDateFrom(range),
      limit: PAGE_LIMIT,
      order: queryOrder,
      ...(cursor ? { cursor } : {}),
      ...(search ? { search: { kind: 'exact_id', value: search } } : {}),
      propertyFilters: [],
      ...(activityMetric ? { activityMetric } : {}),
      ...(interestingMetric
        ? { interesting: { reason: 'recently_activated' as const, metric: interestingMetric } }
        : {}),
    }),
  }), [actorScope]);

  useEffect(() => {
    setCursorStack([null]);
  }, [project, env, range, queryOrder, search, activityMetric, interestingMetric]);

  const registryMetrics = !metrics.loading
    && !metrics.error
    && metrics.data?.scope === registryScope
    ? metrics.data.result
    : null;
  const eventMetrics = useMemo(
    () => (registryMetrics ?? []).filter(isNativeEventMetric),
    [registryMetrics],
  );
  const activationMetrics = useMemo(
    () => eventMetrics.filter((metric) => metric.category === 'activation'),
    [eventMetrics],
  );

  useEffect(() => {
    if (!interestingSelection) return;
    const selectionMatchesScope = interestingSelection.client === client
      && interestingSelection.project === project
      && interestingSelection.env === env;
    if (!selectionMatchesScope) {
      setInterestingSelection(null);
      return;
    }
    if (registryMetrics
      && !activationMetrics.some((metric) => metric.key === interestingSelection.metric)) {
      setInterestingSelection(null);
    }
  }, [activationMetrics, client, env, interestingSelection, project, registryMetrics]);
  const actorData = !actors.loading && !actors.error && actors.data?.scope === actorScope
    ? actors.data.result
    : null;

  const applySearch = (event: FormEvent) => {
    event.preventDefault();
    setSearch(searchInput.trim());
  };

  return (
    <div className="space-y-5">
      <header>
        <h1 className="serif text-3xl sm:text-4xl">People</h1>
        <p className="mt-1 text-sm text-muted-foreground">Bounded actor aggregates resolved from immutable events and explicit identity links.</p>
      </header>

      <AnswerCanvas>
        <div className="border-b px-4 py-3 sm:px-5"><h2 className="text-sm font-semibold">Find people</h2></div>
        <div className="grid gap-3 p-4 md:grid-cols-2 xl:grid-cols-5 sm:p-5">
          <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
            Exact actor ID
            <form className="flex gap-2" onSubmit={applySearch}>
              <Input
                value={searchInput}
                onChange={(event) => setSearchInput(event.target.value)}
                className="h-11 min-w-0"
                maxLength={200}
                placeholder="Canonical or raw ID"
                aria-label="Exact actor ID"
              />
              <Button type="submit" size="icon" className="size-11" aria-label="Run exact actor search">
                <Search className="size-4" />
              </Button>
            </form>
          </label>
          <Control label="Period">
            <Select value={range} onValueChange={(value) => setRange(value as AnalyticsRange)}>
              <SelectTrigger className="!h-11"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem className="min-h-11" value="7d">Last 7 days</SelectItem>
                <SelectItem className="min-h-11" value="30d">Last 30 days</SelectItem>
                <SelectItem className="min-h-11" value="90d">Last 90 days</SelectItem>
              </SelectContent>
            </Select>
          </Control>
          <Control label="Queue">
            <Select
              value={interestingMetric || '__all'}
              onValueChange={(value) => {
                const metric = value === '__all' ? '' : value;
                setInterestingSelection(metric ? { client, project, env, metric } : null);
                if (metric) setActivityMetric('');
              }}
            >
              <SelectTrigger className="!h-11"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem className="min-h-11" value="__all">All observed people</SelectItem>
                {activationMetrics.map((metric) => (
                  <SelectItem className="min-h-11" key={metric.key} value={metric.key}>
                    Recently activated · {metric.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Control>
          <Control label="Order">
            <Select value={order} onValueChange={(value) => setOrder(value as ActorOrder)}>
              <SelectTrigger className="!h-11" disabled={Boolean(interestingMetric)}><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem className="min-h-11" value="last_seen_desc">Last seen</SelectItem>
                <SelectItem className="min-h-11" value="first_seen_desc">First seen</SelectItem>
                <SelectItem className="min-h-11" value="events_desc">Event volume</SelectItem>
              </SelectContent>
            </Select>
          </Control>
          <Control label="Registered activity">
            <Select value={activityMetric || '__all'} onValueChange={(value) => setActivityMetric(value === '__all' ? '' : value)}>
              <SelectTrigger className="!h-11" disabled={Boolean(interestingMetric)}><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem className="min-h-11" value="__all">Any registered event</SelectItem>
                {eventMetrics.map((metric) => <SelectItem className="min-h-11" key={metric.key} value={metric.key}>{metric.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </Control>
        {search && (
          <div className="col-span-full flex items-center gap-2 text-xs text-muted-foreground">
            Exact match: <code>{search}</code>
            <button className="text-foreground underline decoration-muted-foreground/60 underline-offset-2 hover:decoration-foreground" onClick={() => { setSearch(''); setSearchInput(''); }}>Clear</button>
          </div>
        )}
        </div>
      </AnswerCanvas>

      {actors.loading && <Loading what="resolving canonical actors…" />}
      {actors.error && <ErrorNote>{actors.error}</ErrorNote>}
      {actorData && (
        <>
          <PeopleDataHealth capabilities={actorData.meta.capabilities} />
          <AnswerCanvas>
          <div className="flex items-center justify-between gap-3 border-b px-4 py-3 sm:px-5">
            <h2 className="text-sm font-semibold">People</h2>
            <span className="text-xs text-muted-foreground">Bounded observed activity only · page {page + 1}</span>
          </div>
          {actorData.actors.length === 0 ? (
            <EmptyState
              headline="No actors"
              lead={search ? 'No canonical population contains this exact ID in the selected period.' : 'No events matched this scope.'}
            />
          ) : (
            <>
              <div className="overflow-x-auto px-4 sm:px-5">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Person</TableHead>
                      <TableHead>Order evidence</TableHead>
                      <TableHead>First seen</TableHead>
                      <TableHead>Last seen</TableHead>
                      {actorData.meta.capabilities.session_count.project_capability
                        && <TableHead className="text-right">Sessions</TableHead>}
                      <TableHead>Registered activity</TableHead>
                      <TableHead><span className="sr-only">Open</span></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {actorData.actors.map((actor) => (
                      <TableRow key={actor.distinct_id}>
                        <TableCell>
                          <div className="max-w-56 truncate font-mono text-xs" title={actor.distinct_id}>{actor.distinct_id}</div>
                          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                            <span>{fmtNum(actor.total_events)} events · {actor.active_days} active days</span>
                            {(actor.identity_status === 'linked' || actor.identity_status === 'ambiguous')
                              && <IdentityBadge status={actor.identity_status} />}
                          </div>
                        </TableCell>
                        <TableCell>
                          <OrderEvidence
                            reason={actor.order_reason}
                            rankReason={actor.rank_reason}
                            window={actor.rank_evidence_window ?? actorData.meta.date_range}
                          />
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{formatDateTime(actor.first_seen)}</TableCell>
                        <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{formatDateTime(actor.last_seen)}</TableCell>
                        {actorData.meta.capabilities.session_count.project_capability
                          && <TableCell className="text-right tabular-nums">{actor.session_count ?? '—'}</TableCell>}
                        <TableCell>
                          <div className="flex max-w-xs flex-wrap gap-1">
                            {actor.top_events.slice(0, 2).map((event) => (
                              <Badge key={event.event} variant="outline" className="max-w-40 truncate font-mono font-normal">
                                {event.event} · {event.count}
                              </Badge>
                            ))}
                            {actor.top_events.length === 0 && <span className="text-xs text-muted-foreground">None</span>}
                          </div>
                        </TableCell>
                        <TableCell className="text-right">
                          <Button asChild variant="ghost" size="icon-sm" className="size-11 md:size-8">
                            <Link to={`/analyze/users/${encodeURIComponent(actor.distinct_id)}`} aria-label={`Open actor ${actor.distinct_id}`}>
                              <ArrowRight className="size-4" />
                            </Link>
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <div className="mt-4 flex items-center justify-between border-t px-4 py-4 sm:px-5">
                <Button
                  variant="outline"
                  className="h-11 md:h-9"
                  disabled={page === 0}
                  onClick={() => setCursorStack((current) => current.slice(0, -1))}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  className="h-11 md:h-9"
                  disabled={!actorData.meta.next_cursor}
                  onClick={() => {
                    const next = actorData.meta.next_cursor;
                    if (next) setCursorStack((current) => [...current, next]);
                  }}
                >
                  Next
                </Button>
              </div>
            </>
          )}
          <details className="group/disclosure border-t px-4 py-3 text-xs text-muted-foreground sm:px-5">
            <DisclosureSummary className="inline-flex min-h-11 cursor-pointer items-center py-3 font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">How people are resolved</DisclosureSummary>
            Activity properties remain redacted. Exact-ID lookup accepts a canonical or raw actor ID and returns only its canonical bounded aggregate.
            Rows use factual ordering or the explicitly selected activation metric and its registry purpose. Stall, risk and segment changes remain unavailable until a typed semantic source exists.
          </details>
          </AnswerCanvas>
        </>
      )}
    </div>
  );
}

const ORDER_REASON_LABELS: Record<ActorOrderReason, string> = {
  last_seen_in_window: 'Ordered by last seen in this window',
  first_seen_in_window: 'Ordered by first seen in this window',
  event_volume_in_window: 'Ordered by event volume in this window',
  recent_activation_in_window: 'Recently activated in this window',
};

function OrderEvidence({ reason, rankReason, window }: {
  reason: ActorOrderReason;
  rankReason: ActorsResult['actors'][number]['rank_reason'];
  window: { from: string; to: string };
}) {
  return <div className="max-w-sm">
    <Badge variant="outline" className="whitespace-normal text-left font-normal">{ORDER_REASON_LABELS[reason]}</Badge>
    {rankReason && <>
      <div className="mt-1.5 text-xs font-medium">{rankReason.metric_name} · {formatDateTime(rankReason.observed_at)}</div>
      <div className="mt-1 text-xs leading-relaxed text-muted-foreground">{rankReason.metric_purpose}</div>
    </>}
    <div className="mt-1.5 whitespace-nowrap text-xs text-muted-foreground">
      Evidence window: {formatDate(window.from)}–{formatDate(window.to)}
    </div>
  </div>;
}

function PeopleDataHealth({ capabilities }: { capabilities: ActorsResult['meta']['capabilities'] }) {
  return <AnswerCanvas>
    <div className="flex flex-wrap items-start justify-between gap-3 border-b px-4 py-3 sm:px-5">
      <div>
        <h2 className="text-sm font-semibold">People data health</h2>
        <p className="mt-1 text-xs text-muted-foreground">One place for capability limits; rows stay focused on observed evidence.</p>
      </div>
      <Badge variant="secondary">Observed activity only</Badge>
    </div>
    <ul className="grid gap-3 p-4 text-sm sm:p-5 lg:grid-cols-3">
      <li className="rounded-control border p-3">
        <span className="font-medium">Identity enrichment is unavailable.</span>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{capabilities.identity_profile.reason}</p>
      </li>
      <li className="rounded-control border p-3">
        <span className="font-medium">Canonical actor properties are unavailable.</span>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{capabilities.property_filters.reason}</p>
      </li>
      <li className="rounded-control border p-3">
        <span className="font-medium">
          {capabilities.interesting_categories.recently_activated.available
            ? 'Stall, risk and segment-change ranking are unavailable.'
            : 'Activation, stall, risk and segment-change ranking are unavailable.'}
        </span>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          {capabilities.interesting_categories.recently_activated.available
            ? 'Recently activated is available from active native metrics in the activation category.'
            : capabilities.outcome_rank.reason}
        </p>
      </li>
      {!capabilities.session_count.project_capability && <li className="rounded-control border p-3 lg:col-span-3">
        <span className="font-medium">Session counts are hidden.</span>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">Canonical Browser session evidence is not available for this project.</p>
      </li>}
    </ul>
  </AnswerCanvas>;
}

export function IdentityBadge({ status }: { status: ActorIdentityStatus }) {
  const variant = status === 'linked' ? 'default' : status === 'ambiguous' ? 'destructive' : 'outline';
  return <Badge variant={variant}>{actorStatusLabel(status)}</Badge>;
}

function Control({ label, children }: { label: string; children: ReactNode }) {
  return <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">{label}{children}</label>;
}

function isNativeEventMetric(metric: Metric): boolean {
  if (metric.status !== 'active' || metric.type === 'conversion' || metric.type === 'state') return false;
  const source = metric.source as { event?: unknown; data_source?: unknown };
  return typeof source.event === 'string'
    && (source.data_source === undefined || source.data_source === 'native');
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(value));
}
