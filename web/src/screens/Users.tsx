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
  rangeDateFrom,
  type ActorIdentityStatus,
  type ActorOrder,
  type ActorsResult,
  type AnalyticsRange,
} from '../analysis/operations';
import type { Metric } from '../api/types';
import { useAsync, useStore } from '../store';

const PAGE_LIMIT = 50;

export function Users() {
  const { client, project, env } = useStore();
  const [range, setRange] = useState<AnalyticsRange>('30d');
  const [order, setOrder] = useState<ActorOrder>('last_seen_desc');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [activityMetric, setActivityMetric] = useState('');
  const [cursorStack, setCursorStack] = useState<Array<string | null>>([null]);
  const page = cursorStack.length - 1;
  const cursor = cursorStack[page] ?? undefined;
  const metrics = useAsync(
    () => client!.metrics(project!, { status: 'active' }),
    [project, env],
  );
  const actors = useAsync<ActorsResult>(() => client!.operationalQuery<ActorsResult>(project!, {
    kind: 'actors',
    env,
    from: rangeDateFrom(range),
    limit: PAGE_LIMIT,
    order,
    ...(cursor ? { cursor } : {}),
    ...(search ? { search: { kind: 'exact_id', value: search } } : {}),
    propertyFilters: [],
    ...(activityMetric ? { activityMetric } : {}),
  }), [project, env, range, order, search, activityMetric, cursor]);

  useEffect(() => {
    setCursorStack([null]);
  }, [project, env, range, order, search, activityMetric]);

  const eventMetrics = useMemo(
    () => (metrics.data ?? []).filter(isNativeEventMetric),
    [metrics.data],
  );

  const applySearch = (event: FormEvent) => {
    event.preventDefault();
    setSearch(searchInput.trim());
  };

  return (
    <div className="space-y-5">
      <header>
        <h1 className="serif text-3xl sm:text-4xl">People</h1>
        <p className="mt-1 text-sm text-muted-foreground">Anonymous visitors and identified users, resolved from immutable events and active identity links.</p>
      </header>

      <AnswerCanvas>
        <div className="border-b px-4 py-3 sm:px-5"><h2 className="text-sm font-semibold">Find people</h2></div>
        <div className="grid gap-3 p-4 md:grid-cols-2 xl:grid-cols-4 sm:p-5">
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
          <Control label="Order">
            <Select value={order} onValueChange={(value) => setOrder(value as ActorOrder)}>
              <SelectTrigger className="!h-11"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem className="min-h-11" value="last_seen_desc">Last seen</SelectItem>
                <SelectItem className="min-h-11" value="first_seen_desc">First seen</SelectItem>
                <SelectItem className="min-h-11" value="events_desc">Event volume</SelectItem>
              </SelectContent>
            </Select>
          </Control>
          <Control label="Registered activity">
            <Select value={activityMetric || '__all'} onValueChange={(value) => setActivityMetric(value === '__all' ? '' : value)}>
              <SelectTrigger className="!h-11"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem className="min-h-11" value="__all">Any registered event</SelectItem>
                {eventMetrics.map((metric) => <SelectItem className="min-h-11" key={metric.key} value={metric.key}>{metric.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </Control>
        {search && (
          <div className="col-span-full flex items-center gap-2 text-xs text-muted-foreground">
            Exact match: <code>{search}</code>
            <button className="text-primary hover:underline" onClick={() => { setSearch(''); setSearchInput(''); }}>Clear</button>
          </div>
        )}
        </div>
      </AnswerCanvas>

      {actors.loading && <Loading what="resolving canonical actors…" />}
      {actors.error && <ErrorNote>{actors.error}</ErrorNote>}
      {actors.data && (
        <AnswerCanvas>
          <div className="flex items-center justify-between gap-3 border-b px-4 py-3 sm:px-5">
            <h2 className="text-sm font-semibold">People</h2>
            <span className="text-xs text-muted-foreground">Page {page + 1} · max {PAGE_LIMIT}</span>
          </div>
          {actors.data.actors.length === 0 ? (
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
                      <TableHead>Status</TableHead>
                      <TableHead>First seen</TableHead>
                      <TableHead>Last seen</TableHead>
                      <TableHead className="text-right">Sessions</TableHead>
                      <TableHead>Outcome</TableHead>
                      <TableHead>Registered activity</TableHead>
                      <TableHead><span className="sr-only">Open</span></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {actors.data.actors.map((actor) => (
                      <TableRow key={actor.distinct_id}>
                        <TableCell>
                          <div className="max-w-56 truncate font-mono text-xs" title={actor.distinct_id}>{actor.distinct_id}</div>
                          <div className="mt-1 text-xs text-muted-foreground">{fmtNum(actor.total_events)} events · {actor.active_days} active days</div>
                        </TableCell>
                        <TableCell><IdentityBadge status={actor.identity_status} /></TableCell>
                        <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{formatDateTime(actor.first_seen)}</TableCell>
                        <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{formatDateTime(actor.last_seen)}</TableCell>
                        <TableCell className="text-right tabular-nums">{actor.session_count ?? 'Unavailable'}</TableCell>
                        <TableCell><Badge variant={activityMetric ? 'default' : 'outline'}>{activityMetric ? 'Observed' : 'Not assessed'}</Badge></TableCell>
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
                  disabled={!actors.data.meta.next_cursor}
                  onClick={() => {
                    const next = actors.data?.meta.next_cursor;
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
            Activity properties remain redacted. Property filters and pinned properties stay unavailable until a deterministic trusted canonical actor-property source exists.
          </details>
        </AnswerCanvas>
      )}
    </div>
  );
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
