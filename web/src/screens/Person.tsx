import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Copy } from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { EmptyState, ErrorNote, Loading, Panel, Stat, fmtNum } from '@/components/ui';
import {
  actorStatusLabel,
  rangeDateFrom,
  type AnalyticsRange,
  type PersonResult,
} from '../analysis/operations';
import { useAsync, useStore } from '../store';
import { IdentityBadge } from './Users';

export function Person() {
  const { distinctId = '' } = useParams();
  const { client, project, env } = useStore();
  const [range, setRange] = useState<AnalyticsRange>('30d');
  const [cursorStack, setCursorStack] = useState<Array<string | null>>([null]);
  const cursor = cursorStack.at(-1) ?? undefined;
  const page = cursorStack.length - 1;
  const person = useAsync<PersonResult>(
    () => client!.personSummary(project!, distinctId, {
      env,
      from: rangeDateFrom(range),
      limit: 50,
      ...(cursor ? { cursor } : {}),
    }),
    [project, env, distinctId, range, cursor],
  );

  useEffect(() => setCursorStack([null]), [project, env, distinctId, range]);

  if (person.loading) return <Loading what="resolving canonical actor…" />;
  if (person.error) return <ErrorNote>{person.error}</ErrorNote>;
  if (!person.data) return null;

  const data = person.data;
  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <Link to="/analyze/users" className="mb-1 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
            <ArrowLeft className="size-3" /> Users
          </Link>
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="serif truncate text-3xl">Actor profile</h1>
            <IdentityBadge status={data.identity.status} />
          </div>
          <button
            className="mt-1 flex max-w-full items-center gap-1 font-mono text-xs text-muted-foreground hover:text-foreground"
            onClick={() => navigator.clipboard?.writeText(data.distinct_id)}
          >
            <span className="truncate">{data.distinct_id}</span>
            <Copy className="size-3 shrink-0" />
          </button>
        </div>
        <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
          Period
          <Select value={range} onValueChange={(value) => setRange(value as AnalyticsRange)}>
            <SelectTrigger className="!h-11 w-40"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem className="min-h-11" value="7d">Last 7 days</SelectItem>
              <SelectItem className="min-h-11" value="30d">Last 30 days</SelectItem>
              <SelectItem className="min-h-11" value="90d">Last 90 days</SelectItem>
            </SelectContent>
          </Select>
        </label>
      </header>

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <Stat label="Events" value={fmtNum(data.summary.total_events)} sub={`${data.summary.distinct_events} registered types`} />
        <Stat label="Active days" value={data.summary.active_days} sub="inside this exact window" />
        <Stat label="Sessions" value={data.summary.session_count ?? 'Unavailable'} sub="trusted browser evidence only" />
        <Stat label="Raw IDs" value={data.identity.raw_actor_count} sub={actorStatusLabel(data.identity.status)} />
      </div>

      <Tabs defaultValue="overview" className="gap-4">
        <div className="max-w-full overflow-x-auto pb-1">
          <TabsList className="w-max">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="activity">Activity</TabsTrigger>
            <TabsTrigger value="identity">Identity</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="overview">
          <div className="grid gap-4 lg:grid-cols-2">
            <Panel title="Top registered events">
              {data.summary.top_events.length === 0 ? (
                <EmptyState headline="No registered activity" />
              ) : (
                <div className="divide-y">
                  {data.summary.top_events.map((event) => (
                    <div key={event.event} className="flex items-center justify-between gap-3 py-3">
                      <code className="min-w-0 truncate text-xs">{event.event}</code>
                      <span className="shrink-0 font-mono text-sm tabular-nums">{event.count}</span>
                    </div>
                  ))}
                </div>
              )}
            </Panel>
            <Panel title="Evidence window">
              <Definition label="Requested ID" value={data.requested_distinct_id} mono />
              <Definition label="First seen" value={formatOptionalDate(data.summary.first_seen)} />
              <Definition label="Last seen" value={formatOptionalDate(data.summary.last_seen)} />
              <Definition label="Registered coverage" value={`${(data.summary.registered_share * 100).toFixed(1)}%`} />
              <div className="mt-3 rounded-panel border border-dashed p-3 text-xs text-muted-foreground">
                Entity properties and pinned traits are unavailable. Poolstatis does not infer identity or contactability from email, name or ID shape.
              </div>
            </Panel>
          </div>
        </TabsContent>

        <TabsContent value="activity">
          <Panel
            title="Registered activity"
            right={<Badge variant="outline">Properties masked</Badge>}
          >
            {data.activity.events.length === 0 ? (
              <EmptyState headline="No activity" lead="No registered events matched this actor and period." />
            ) : (
              <>
                <div className="divide-y">
                  {data.activity.events.map((event, index) => (
                    <div key={`${event.timestamp}:${event.event}:${index}`} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium">{event.event}</div>
                        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 font-mono text-xs text-muted-foreground">
                          <span>raw {event.raw_distinct_id}</span>
                          {event.session_id && <span>session {event.session_id}</span>}
                        </div>
                      </div>
                      <time className="whitespace-nowrap text-xs text-muted-foreground">{formatDateTime(event.timestamp)}</time>
                    </div>
                  ))}
                </div>
                <div className="mt-4 flex items-center justify-between border-t pt-4">
                  <Button
                    variant="outline"
                    className="h-11 md:h-9"
                    disabled={page === 0}
                    onClick={() => setCursorStack((current) => current.slice(0, -1))}
                  >
                    Previous
                  </Button>
                  <span className="text-xs text-muted-foreground">Page {page + 1}</span>
                  <Button
                    variant="outline"
                    className="h-11 md:h-9"
                    disabled={!data.activity.next_cursor}
                    onClick={() => {
                      if (data.activity.next_cursor) setCursorStack((current) => [...current, data.activity.next_cursor]);
                    }}
                  >
                    Next
                  </Button>
                </div>
              </>
            )}
          </Panel>
        </TabsContent>

        <TabsContent value="identity">
          <div className="grid gap-4 lg:grid-cols-2">
            <Panel title="Resolved population">
              <Definition label="Canonical ID" value={data.distinct_id} mono />
              <Definition label="Status" value={actorStatusLabel(data.identity.status)} />
              <div className="mt-4 text-xs font-medium text-muted-foreground">Raw distinct IDs</div>
              <div className="mt-2 space-y-2">
                {data.identity.raw_distinct_ids.map((id) => (
                  <code key={id} className="block break-all rounded-control bg-muted px-3 py-2 text-xs">{id}</code>
                ))}
                {data.identity.raw_distinct_ids_truncated && <div className="text-xs text-muted-foreground">Raw ID list is truncated at the provenance bound.</div>}
              </div>
            </Panel>
            <Panel title="Active link provenance">
              {data.identity.links.length === 0 ? (
                <EmptyState headline="No active links" lead="The truthful identity status remains unknown without server-owned link provenance." />
              ) : (
                <div className="divide-y">
                  {data.identity.links.map((link) => (
                    <div key={link.id} className="py-3">
                      <div className="grid gap-1 font-mono text-xs">
                        <span className="break-all">{link.source_distinct_id}</span>
                        <span className="text-muted-foreground">to</span>
                        <span className="break-all">{link.target_distinct_id}</span>
                      </div>
                      <div className="mt-2 text-xs text-muted-foreground">{formatDateTime(link.created_at)} · {link.created_by}</div>
                    </div>
                  ))}
                  {data.identity.links_truncated && <div className="pt-3 text-xs text-muted-foreground">Link provenance is truncated.</div>}
                </div>
              )}
            </Panel>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function Definition({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="border-b py-3 last:border-b-0">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={mono ? 'mt-1 break-all font-mono text-xs' : 'mt-1 text-sm'}>{value}</div>
    </div>
  );
}

function formatOptionalDate(value: string | null): string {
  return value ? formatDateTime(value) : 'Unavailable';
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}
