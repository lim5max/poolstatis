import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Copy, Trash2, ExternalLink } from '@/components/icons';
import { useStore, useAsync } from '../store';
import {
  Panel, Stat, Meter, EmptyState, Loading, ErrorNote, DangerConfirm, RegBadge, Hint,
  fmtNum, fmtRelative, fmtDur, daysBetween, fmtVal,
} from '../components/ui';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { SampleEvent } from '../api/types';

const PINNED = ['email', 'name', 'plan', 'registered_at'];

export function Person() {
  const { distinctId = '' } = useParams();
  const { client, project, env, tokenKind } = useStore();
  const person = useAsync(() => client!.personSummary(project!, distinctId, env), [project, env, distinctId]);
  const feed = useAsync(() => client!.sample(project!, { env, distinct_id: distinctId, limit: 100 }), [project, env, distinctId]);
  const [selected, setSelected] = useState<SampleEvent | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [del, setDel] = useState(false);

  if (person.loading) return <Loading what="profiling actor…" />;
  if (person.error) return <ErrorNote>{person.error}</ErrorNote>;
  if (!person.data) return null;

  const { summary, entity } = person.data;
  const props = entity?.properties ?? {};
  const traits = deriveTraits(summary, entity);
  const events = feed.data ?? [];

  const keys = Object.keys(props);
  const pinned = PINNED.filter((k) => k in props);
  const rest = keys.filter((k) => !pinned.includes(k));
  const shownRest = showAll ? rest : rest.slice(0, 8);
  const tenure = daysBetween(summary.first_seen, summary.last_seen);

  return (
    <div className="space-y-4">
      {/* header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <span className="size-12 rounded-full bg-secondary ring-2 ring-primary/40 flex items-center justify-center serif text-2xl text-primary">
            {(String(props.name ?? distinctId)[0] ?? '?').toUpperCase()}
          </span>
          <div>
            <Link to="/data" className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 mb-0.5"><ArrowLeft className="size-3" /> Data</Link>
            <div className="serif text-2xl">{String(props.name ?? distinctId)}</div>
            <button className="text-xs text-muted-foreground font-mono flex items-center gap-1 hover:text-primary" onClick={() => navigator.clipboard?.writeText(distinctId)}>{distinctId} <Copy className="size-3" /></button>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button asChild variant="outline" size="sm"><Link to={`/data?tab=events&distinct_id=${encodeURIComponent(distinctId)}`}><ExternalLink className="size-3.5" /> Events</Link></Button>
          {/* Purge needs a project secret key (sk_); the endpoint 403s otherwise. Gate it
              like Setup's danger zone instead of letting a confirmed action silently fail. */}
          {tokenKind === 'secret' ? (
            <Button variant="destructive" size="sm" onClick={() => setDel(true)}><Trash2 className="size-3.5" /> Delete events</Button>
          ) : (
            <Hint label={`Deleting events needs a project secret key (sk_) — you're connected with a ${tokenKind} token.`}>
              <span><Button variant="destructive" size="sm" disabled className="pointer-events-none"><Trash2 className="size-3.5" /> Delete events</Button></span>
            </Hint>
          )}
        </div>
      </div>

      {/* derived traits — the segments a client would group on */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">Derived traits</span>
        {traits.map((t) => <Hint key={t.label} label={t.hint}><Badge variant="secondary" className="cursor-help">{t.label}</Badge></Hint>)}
      </div>

      {/* stats strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="Total events" value={fmtNum(summary.total_events)} sub={`${summary.distinct_events} distinct`} />
        <Stat label="Active days" value={summary.active_days} sub={`${summary.sessions} sessions`} />
        <Stat label="First seen" value={fmtRelative(summary.first_seen)} sub={`tenure ${fmtDur(tenure)}`} />
        <Stat label="Last seen" value={fmtRelative(summary.last_seen)} sub={summary.top_events[0] ? `top: ${summary.top_events[0].event}` : '—'} />
      </div>

      <div className={cn('grid gap-4 grid-cols-1', 'lg:grid-cols-[1fr_320px]')}>
        {/* main: top events + activity */}
        <div className="space-y-4">
          <Panel title="Top events">
            {summary.top_events.length === 0 ? <EmptyState headline="No events" /> : (
              <div className="space-y-2.5">
                {summary.top_events.map((e) => (
                  <div key={e.event} className="flex items-center gap-3">
                    <span className="w-44 truncate font-mono text-xs">{e.event}</span>
                    <div className="flex-1"><Meter value={summary.total_events ? e.count / summary.top_events[0]!.count : 0} /></div>
                    <span className="w-10 text-right tabular-nums text-xs">{e.count}</span>
                  </div>
                ))}
              </div>
            )}
          </Panel>

          <Panel title={<>Activity <span className="font-sans text-muted-foreground text-sm font-normal ml-2">last {events.length} events</span></>}>
            {feed.loading ? <Loading /> : events.length === 0 ? <EmptyState headline="No activity" lead="no events for this actor in this env" /> : (
              <div className="divide-y">
                {events.map((e, i) => (
                  <div key={i}>
                    <button className="w-full flex items-center justify-between gap-3 py-2.5 text-left hover:bg-accent/40 px-1 rounded" onClick={() => setSelected(selected === e ? null : e)}>
                      <span className="font-medium text-sm">{e.event}</span>
                      <span className="flex items-center gap-3">
                        <span className="text-xs text-muted-foreground">{new Date(e.timestamp).toLocaleString()}</span>
                        <RegBadge registered={e.registered} />
                      </span>
                    </button>
                    {selected === e && (
                      <pre className="mb-2 rounded-panel border bg-card p-3 text-xs overflow-auto max-h-72 whitespace-pre-wrap">{JSON.stringify({ event: e.event, timestamp: e.timestamp, session_id: e.session_id, properties: e.properties }, null, 2)}</pre>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Panel>
        </div>

        {/* right rail: entity properties */}
        <Panel title="Properties">
          {keys.length === 0 ? (
            <div className="text-xs text-muted-foreground">No entity profile — this actor has events but no upserted <code>user</code> entity. Upsert one to attach attributes.</div>
          ) : (
            <>
              {[...pinned, ...shownRest].map((k) => (
                <div key={k} className="py-2 border-b last:border-0"><div className="text-xs text-muted-foreground">{k}</div><div className="text-sm break-words">{fmtVal(props[k])}</div></div>
              ))}
              {rest.length > 8 && <button className="text-xs text-muted-foreground hover:text-primary mt-2" onClick={() => setShowAll((s) => !s)}>{showAll ? 'show less' : `show ${rest.length - 8} more`}</button>}
            </>
          )}
          <div className="text-xs text-muted-foreground mt-4 pt-3 border-t">Stats are derived from events — Poolstatis is server-native and doesn't auto-capture IP/geo/device. Set those as entity properties if you need them.</div>
        </Panel>
      </div>

      {del && (
        <DangerConfirm title={`Delete events for ${distinctId}?`}
          blastRadius="Removes every event for this actor in the current environment."
          willDelete={[`all events where distinct_id = ${distinctId}`]} willKeep={['the entity/profile row', "other actors' events"]}
          matchValue={distinctId} matchLabel="Type the distinct_id to confirm" confirmLabel="Delete user events"
          onCancel={() => setDel(false)}
          onConfirm={async () => { await client!.purgeData(project!, { env, scope: 'events', confirm_slug: project!, distinct_id: distinctId }); setDel(false); person.reload(); feed.reload(); }} />
      )}
    </div>
  );
}

interface Trait { label: string; hint: string }
function deriveTraits(s: { last_seen: string | null; first_seen: string | null; total_events: number; active_days: number }, entity: { properties: Record<string, unknown> } | null): Trait[] {
  const t: Trait[] = [];
  const recencyDays = s.last_seen ? (Date.now() - new Date(s.last_seen).getTime()) / 86_400_000 : Infinity;
  if (recencyDays < 7) t.push({ label: 'Active', hint: 'Seen in the last 7 days — the recency (R in RFM) win-back vs nurture cut.' });
  else if (recencyDays < 30) t.push({ label: 'Dormant', hint: 'Last seen 7–30 days ago — at risk; a win-back target.' });
  else t.push({ label: 'Churned', hint: 'Not seen in 30+ days — churned.' });

  const freq = s.active_days ? s.total_events / s.active_days : 0;
  t.push(freq >= 5
    ? { label: 'Power user', hint: `~${freq.toFixed(1)} events per active day — high engagement intensity (F in RFM).` }
    : { label: 'Casual', hint: `~${freq.toFixed(1)} events per active day — low intensity.` });

  const tenure = daysBetween(s.first_seen, s.last_seen);
  t.push(tenure >= 30
    ? { label: 'Established', hint: 'Active span of 30+ days — a tenured user.' }
    : { label: 'New', hint: 'Active span under 30 days — a new/establishing user.' });

  const p = entity?.properties ?? {};
  t.push('email' in p || 'name' in p
    ? { label: 'Identified', hint: 'Has an identity entity with email/name — contactable.' }
    : { label: 'Anonymous', hint: 'No identity entity with email/name — not contactable.' });
  return t;
}
