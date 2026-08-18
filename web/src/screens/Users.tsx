import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ArrowRight, Funnel, Search, UserCircle, UserGroup } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { EmptyState, ErrorNote, Loading, PageHeading, fmtNum } from '@/components/ui';
import { AnswerCanvas } from '@/components/analytics';
import { AnalyticsDateRange } from '@/components/AnalyticsDateRange';
import { useAnalyticsRange } from '../analysis/useAnalyticsRange';
import { analyticsNavigationTarget } from '../analysis/navigation';
import {
  type ActorOrder,
  type ActorsResult,
} from '../analysis/operations';
import type { EntityRow, EntityType, Metric } from '../api/types';
import { useAsync, useStore } from '../store';

const PAGE_LIMIT = 50;

interface InterestingMetricSelection {
  client: ReturnType<typeof useStore>['client'];
  project: string | null;
  env: string;
  metric: string;
}

export function Users() {
  const location = useLocation();
  const { client, project, env } = useStore();
  const { selection: rangeSelection, resolved: range, setSelection: setRangeSelection } = useAnalyticsRange();
  const [surface, setSurface] = useState<'people' | 'groups'>('people');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [order, setOrder] = useState<ActorOrder>('last_seen_desc');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [activityMetric, setActivityMetric] = useState('');
  const [interestingSelection, setInterestingSelection] = useState<InterestingMetricSelection | null>(null);
  const [groupType, setGroupType] = useState('');
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
    project, env, range.from, range.to, queryOrder, search, activityMetric, interestingMetric, cursor ?? null,
  ]);
  const actorScope = useMemo(() => ({ client, key: actorScopeKey }), [client, actorScopeKey]);
  const actors = useAsync<{ scope: typeof actorScope; identity: typeof registryScope; result: ActorsResult }>(async () => ({
    scope: actorScope,
    identity: registryScope,
    result: await client!.operationalQuery<ActorsResult>(project!, {
      kind: 'actors',
      env,
      from: range.from,
      to: range.to,
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
  }), [actorScope], { keepPreviousData: true });
  const groupRegistryScope = useMemo(() => ({ client, project, env, surface }), [client, project, env, surface]);
  const entityTypes = useAsync<{ scope: typeof groupRegistryScope; result: EntityType[] }>(async () => ({
    scope: groupRegistryScope,
    result: surface === 'groups' && client && typeof client.schema === 'function'
      ? (await client.schema(project!, env)).entity_types.filter((type) => type.name !== 'user')
      : [],
  }), [groupRegistryScope]);
  const visibleEntityTypes = !entityTypes.loading
    && !entityTypes.error
    && entityTypes.data?.scope === groupRegistryScope
    ? entityTypes.data.result
    : null;
  const groupScopeKey = JSON.stringify([project, env, surface, groupType]);
  const groupScope = useMemo(() => ({ client, key: groupScopeKey }), [client, groupScopeKey]);
  const groups = useAsync<{ scope: typeof groupScope; result: EntityRow[] }>(async () => ({
    scope: groupScope,
    result: surface === 'groups' && groupType && client && typeof client.entities === 'function'
      ? await client.entities(project!, { entity_type: groupType, env, limit: PAGE_LIMIT })
      : [],
  }), [groupScope], { keepPreviousData: true });

  useEffect(() => {
    setCursorStack([null]);
  }, [project, env, range.from, range.to, queryOrder, search, activityMetric, interestingMetric]);

  useEffect(() => {
    if (surface !== 'groups' || !visibleEntityTypes) return;
    setGroupType((current) => visibleEntityTypes.some((type) => type.name === current)
      ? current
      : visibleEntityTypes[0]?.name ?? '');
  }, [surface, visibleEntityTypes]);

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
  const exactActorData = !actors.error && actors.data?.scope === actorScope ? actors.data.result : null;
  const actorData = exactActorData ?? (
    actors.loading && actors.data?.identity === registryScope ? actors.data.result : null
  );
  const groupData = !groups.error && groups.data?.scope === groupScope ? groups.data.result : null;

  const applySearch = (event: FormEvent) => {
    event.preventDefault();
    setSearch(searchInput.trim());
  };

  return (
    <div className="space-y-5">
      <PageHeading
        title="People"
        lead="Find observed people and activity."
        help="Rows are bounded actor aggregates from immutable events and explicit identity links. Poolstatis does not infer profiles or risk scores without supporting data."
      />

      <div className="border-b">
        <div role="tablist" aria-label="People view" className="flex gap-6">
          <ViewTab active={surface === 'people'} onClick={() => setSurface('people')} icon={<UserCircle className="size-4" />}>All people</ViewTab>
          <ViewTab active={surface === 'groups'} onClick={() => setSurface('groups')} icon={<UserGroup className="size-4" />}>Groups</ViewTab>
        </div>
      </div>

      {surface === 'people' && <>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" aria-expanded={filtersOpen} onClick={() => setFiltersOpen((open) => !open)}>
            <Funnel className="size-4" /> Filters
          </Button>
          <form className="ml-auto flex min-w-64 flex-1 gap-2 sm:max-w-sm" onSubmit={applySearch}>
            <Input
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              className="h-10 min-w-0"
              maxLength={200}
              placeholder="Search exact user ID"
              aria-label="Exact actor ID"
            />
            <Button type="submit" size="icon-sm" className="size-10" aria-label="Run exact actor search">
              <Search className="size-4" />
            </Button>
          </form>
          <AnalyticsDateRange value={rangeSelection} onChange={setRangeSelection} />
        </div>

        {filtersOpen && <div className="grid gap-3 rounded-panel border bg-card p-4 sm:grid-cols-3">
            <Control label="Queue">
              <Select
                value={interestingMetric || '__all'}
                onValueChange={(value) => {
                  const metric = value === '__all' ? '' : value;
                  setInterestingSelection(metric ? { client, project, env, metric } : null);
                  if (metric) setActivityMetric('');
                }}
              >
                <SelectTrigger className="!h-10"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem className="min-h-10" value="__all">All observed people</SelectItem>
                  {activationMetrics.map((metric) => (
                    <SelectItem className="min-h-10" key={metric.key} value={metric.key}>
                      Recently activated · {metric.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Control>
            <Control label="Order">
              <Select value={order} onValueChange={(value) => setOrder(value as ActorOrder)}>
                <SelectTrigger className="!h-10" disabled={Boolean(interestingMetric)}><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem className="min-h-10" value="last_seen_desc">Last seen</SelectItem>
                  <SelectItem className="min-h-10" value="first_seen_desc">First seen</SelectItem>
                  <SelectItem className="min-h-10" value="events_desc">Event volume</SelectItem>
                </SelectContent>
              </Select>
            </Control>
            <Control label="Activity">
              <Select value={activityMetric || '__all'} onValueChange={(value) => setActivityMetric(value === '__all' ? '' : value)}>
                <SelectTrigger className="!h-10" disabled={Boolean(interestingMetric)}><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem className="min-h-10" value="__all">Any registered event</SelectItem>
                  {eventMetrics.map((metric) => <SelectItem className="min-h-10" key={metric.key} value={metric.key}>{metric.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </Control>
          </div>}
        {search && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            Exact match: <code>{search}</code>
            <button className="text-foreground underline decoration-muted-foreground/60 underline-offset-2 hover:decoration-foreground" onClick={() => { setSearch(''); setSearchInput(''); }}>Clear</button>
          </div>
        )}

        {actors.loading && !actorData && <Loading what="resolving canonical actors…" />}
        {actors.error && <ErrorNote>{actors.error}</ErrorNote>}
        {actorData && (
        <>
          <AnswerCanvas>
          <div className="flex items-center justify-between gap-3 border-b px-4 py-3 sm:px-5">
            <h2 className="text-sm font-semibold">People</h2>
            <span className="text-sm text-muted-foreground">
              {actors.loading && <span role="status">Updating · </span>}{range.label} · page {page + 1}
            </span>
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
                      <TableHead>User</TableHead>
                      <TableHead className="hidden md:table-cell">Last activity</TableHead>
                      <TableHead className="text-right">Events</TableHead>
                      <TableHead className="hidden text-right md:table-cell">Active days</TableHead>
                      {actorData.meta.capabilities.session_count.project_capability
                        && <TableHead className="hidden text-right md:table-cell">Sessions</TableHead>}
                      <TableHead><span className="sr-only">Open</span></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {actorData.actors.map((actor) => (
                      <TableRow key={actor.distinct_id}>
                        <TableCell>
                          <div className="flex min-w-0 items-center gap-3">
                            <GeneratedAvatar id={actor.distinct_id} />
                            <div className="min-w-0">
                              <div className="truncate text-sm font-medium" title="Stable display alias; not a verified name">{anonymousAlias(actor.distinct_id)}</div>
                              <div className="mt-0.5 max-w-64 truncate font-mono text-sm text-muted-foreground" title={actor.distinct_id}>{actor.distinct_id}</div>
                            </div>
                          </div>
                          {actor.rank_reason && <div className="mt-2 max-w-md text-sm">
                            <span className="font-medium">{actor.rank_reason.metric_name} · {formatDateTime(actor.rank_reason.observed_at)}</span>
                            <p className="mt-1 whitespace-normal leading-relaxed text-muted-foreground">{actor.rank_reason.metric_purpose}</p>
                          </div>}
                        </TableCell>
                        <TableCell className="hidden whitespace-nowrap text-sm text-muted-foreground md:table-cell">{formatDateTime(actor.last_seen)}</TableCell>
                        <TableCell className="text-right font-mono text-sm tabular-nums">{fmtNum(actor.total_events)}</TableCell>
                        <TableCell className="hidden text-right font-mono text-sm tabular-nums md:table-cell">{actor.active_days}</TableCell>
                        {actorData.meta.capabilities.session_count.project_capability
                          && <TableCell className="hidden text-right tabular-nums md:table-cell">{actor.session_count ?? '—'}</TableCell>}
                        <TableCell className="text-right">
                          <Button asChild variant="ghost" size="icon-sm" className="size-11 md:size-8">
                            <Link
                              to={analyticsNavigationTarget(`/analyze/users/${encodeURIComponent(actor.distinct_id)}`, location.search)}
                              aria-label={`Open actor ${actor.distinct_id}`}
                            >
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
          </AnswerCanvas>
        </>
        )}
      </>}

      {surface === 'groups' && <>
        <div className="flex flex-wrap items-end justify-between gap-3">
          {visibleEntityTypes && visibleEntityTypes.length > 0 && <Control label="Group type">
            <Select value={groupType} onValueChange={setGroupType}>
              <SelectTrigger className="!h-10 min-w-56"><SelectValue /></SelectTrigger>
              <SelectContent>
                {visibleEntityTypes.map((type) => <SelectItem key={type.name} value={type.name}>{type.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </Control>}
          <span className="text-sm text-muted-foreground">Current entity state · <code>{env}</code></span>
        </div>
        {(entityTypes.loading || groups.loading) && !groupData && <Loading what="loading groups…" />}
        {(entityTypes.error || groups.error) && <ErrorNote>{entityTypes.error ?? groups.error}</ErrorNote>}
        {visibleEntityTypes?.length === 0 && <EmptyState headline="No groups registered" lead="Register an account, team, or workspace entity type before groups can be listed." />}
        {visibleEntityTypes && visibleEntityTypes.length > 0 && groupData && <GroupsTable type={groupType} groups={groupData} updating={groups.loading} />}
      </>}
    </div>
  );
}

function ViewTab({ active, onClick, icon, children }: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`flex min-h-11 items-center gap-2 border-b-2 px-1 text-sm font-medium ${active ? 'border-foreground text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
    >
      {icon}{children}
    </button>
  );
}

const AVATARS = [
  { glyph: '🦊', tone: 'bg-orange-100 text-orange-900' },
  { glyph: '🐼', tone: 'bg-violet-100 text-violet-900' },
  { glyph: '🐸', tone: 'bg-cyan-100 text-cyan-900' },
  { glyph: '🐧', tone: 'bg-sky-100 text-sky-900' },
  { glyph: '🐱', tone: 'bg-rose-100 text-rose-900' },
  { glyph: '🐻', tone: 'bg-amber-100 text-amber-900' },
] as const;
const ALIAS_ADJECTIVES = ['Bright', 'Calm', 'Clever', 'Curious', 'Gentle', 'Quick', 'Quiet', 'Sunny'] as const;
const ALIAS_NOUNS = ['Badger', 'Finch', 'Fox', 'Heron', 'Otter', 'Panda', 'Robin', 'Turtle'] as const;

function stableHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function anonymousAlias(id: string): string {
  const hash = stableHash(id);
  return `Visitor ${ALIAS_ADJECTIVES[hash % ALIAS_ADJECTIVES.length]} ${ALIAS_NOUNS[Math.floor(hash / ALIAS_ADJECTIVES.length) % ALIAS_NOUNS.length]}`;
}

function GeneratedAvatar({ id }: { id: string }) {
  const avatar = AVATARS[stableHash(id) % AVATARS.length]!;
  return <span aria-hidden="true" className={`flex size-9 shrink-0 items-center justify-center rounded-full text-lg ${avatar.tone}`}>{avatar.glyph}</span>;
}

function GroupsTable({ type, groups, updating }: { type: string; groups: EntityRow[]; updating: boolean }) {
  return (
    <AnswerCanvas>
      <div className="flex items-center justify-between gap-3 border-b px-4 py-3 sm:px-5">
        <h2 className="text-sm font-semibold">Groups</h2>
        <span className="text-sm text-muted-foreground">{updating && <span role="status">Updating · </span>}{groups.length} {type || 'group'} records</span>
      </div>
      {groups.length === 0 ? <EmptyState headline="No groups" lead={`No ${type || 'group'} entities exist in this environment.`} /> : (
        <div className="overflow-x-auto px-4 sm:px-5">
          <Table>
            <TableHeader><TableRow>
              <TableHead>Group</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Updated</TableHead>
              <TableHead className="text-right">Attributes</TableHead>
            </TableRow></TableHeader>
            <TableBody>{groups.map((group) => (
              <TableRow key={group.entity_id}>
                <TableCell>
                  <div className="flex min-w-0 items-center gap-3">
                    <GeneratedAvatar id={`${type}:${group.entity_id}`} />
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">{groupDisplayName(group)}</div>
                      <div className="mt-0.5 max-w-72 truncate font-mono text-sm text-muted-foreground" title={group.entity_id}>{group.entity_id}</div>
                    </div>
                  </div>
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">{type}</TableCell>
                <TableCell className="whitespace-nowrap text-sm text-muted-foreground">{formatDateTime(group.updated_at)}</TableCell>
                <TableCell className="text-right font-mono text-sm tabular-nums">{Object.keys(group.properties).length}</TableCell>
              </TableRow>
            ))}</TableBody>
          </Table>
        </div>
      )}
    </AnswerCanvas>
  );
}

function groupDisplayName(group: EntityRow): string {
  for (const key of ['name', 'display_name', 'title']) {
    const value = group.properties[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return group.entity_id;
}

function Control({ label, children }: { label: string; children: ReactNode }) {
  return <label className="grid min-w-44 gap-1.5 text-sm font-medium text-muted-foreground">{label}{children}</label>;
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
