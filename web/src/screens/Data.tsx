import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Add as Plus, X } from '@/components/icons';
import { useStore, useAsync } from '../store';
import {
  Loading, ErrorNote, RecoverableError, Panel, EmptyState, Meter, Stat, Toolbar, SearchInput, RegBadge, fmtNum, fmtPct, fmtVal,
} from '../components/ui';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import type { DataQualityIssue, EntityRow, FilterOp, ObservedEvent, SampleFilter } from '../api/types';

function EnvSelect() {
  const { env, setEnv, availableEnvs } = useStore();
  if (availableEnvs.length <= 1) return null;
  return (
    <Select value={env} onValueChange={setEnv}>
      <SelectTrigger size="sm" className="w-28"><span className="text-muted-foreground text-xs mr-1">env</span><SelectValue /></SelectTrigger>
      <SelectContent>{availableEnvs.map((e) => <SelectItem key={e} value={e}>{e}</SelectItem>)}</SelectContent>
    </Select>
  );
}

export function Data() {
  const { client, project, env } = useStore();
  const [params] = useSearchParams();
  // Deep links: ?tab=events&event=<name> (from a metric) or &distinct_id=<id> (from a person).
  const [tab, setTab] = useState(params.get('tab') ?? 'health');
  const eventParam = params.get('event') ?? undefined;
  const actorParam = params.get('distinct_id') ?? undefined;
  const schema = useAsync(() => client!.schema(project!, env), [project, env]);
  if (schema.loading) return <Loading what="reading data…" />;
  if (schema.error) return <RecoverableError onRetry={schema.reload}>{schema.error}</RecoverableError>;
  if (!schema.data) return null;

  return (
    <Tabs value={tab} onValueChange={setTab} className="gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="max-w-full overflow-x-auto pb-1">
          <TabsList className="w-max">
            <TabsTrigger value="health">Data health</TabsTrigger>
            <TabsTrigger value="events">Event stream</TabsTrigger>
            <TabsTrigger value="entities">Entities</TabsTrigger>
            <TabsTrigger value="warnings">Warnings</TabsTrigger>
          </TabsList>
        </div>
        <EnvSelect />
      </div>
      <TabsContent value="health"><Health observed={schema.data.observed_events_30d} /></TabsContent>
      <TabsContent value="events"><EventStream initialEvent={eventParam} initialActor={actorParam} observed={schema.data.observed_events_30d} /></TabsContent>
      <TabsContent value="entities"><Entities types={schema.data.entity_types.map((t) => t.name)} /></TabsContent>
      <TabsContent value="warnings"><Warnings /></TabsContent>
    </Tabs>
  );
}

function Health({ observed }: { observed: ObservedEvent[] }) {
  const { client, project, env } = useStore();
  const quality = useAsync(() => client!.dataQuality(project!, { env, limit: 50 }), [project, env]);
  const events = [...observed].sort((a, b) => b.count - a.count);
  const total = events.reduce((s, e) => s + e.count, 0);
  const weighted = events.reduce((s, e) => s + e.count * e.registered_share, 0);
  const coverage = total ? weighted / total : 1;
  const wild = events.filter((e) => e.registered_share < 0.999);
  const qualityIssues = quality.loading || quality.error ? undefined : quality.data?.issues;
  const issueCount = quality.error ? 'error' : quality.loading ? '…' : (qualityIssues?.length ?? 0);
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        <Stat label="Instrumentation coverage" value={fmtPct(coverage)} sub="of 30-day volume" />
        <Stat label="Off-standard names" value={wild.length} sub="no matching active metric" />
        <Stat label="Entity conflicts" value={quality.loading ? '…' : issueCount} sub="events vs current status" />
        <Stat label="Distinct events" value={events.length} sub={`${fmtNum(total)} total · 30d`} />
      </div>
      <DataQualityPanel loading={quality.loading} error={quality.error} issues={qualityIssues} />
      <Panel title="Observed events · 30 days">
        {events.length === 0 ? <EmptyState headline="No events yet" lead="send some to the ingest API to see them here" /> : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader><TableRow><TableHead>Event</TableHead><TableHead className="w-56">Registered</TableHead><TableHead className="text-right w-28">Count</TableHead><TableHead>Last seen</TableHead></TableRow></TableHeader>
              <TableBody>
                {events.map((e) => (
                  <TableRow key={e.event}>
                    <TableCell className={cn('font-medium', e.registered_share < 0.999 && 'text-destructive')}>{e.event}</TableCell>
                    <TableCell><div className="flex items-center gap-2.5"><div className="flex-1"><Meter value={e.registered_share} /></div><span className="text-xs tabular-nums w-9 text-right">{fmtPct(e.registered_share)}</span></div></TableCell>
                    <TableCell className="text-right tabular-nums">{fmtNum(e.count)}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{new Date(e.last_seen).toLocaleString()}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Panel>
    </div>
  );
}

function DataQualityPanel({ loading, error, issues }: { loading: boolean; error: string | null; issues?: DataQualityIssue[] }) {
  return (
    <Panel title="Entity/event consistency">
      {loading && <Loading />}
      {error && <ErrorNote>{error}</ErrorNote>}
      {issues && (issues.length === 0 ? (
        <EmptyState headline="No conflicts" lead="terminal events match current entity status" />
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader><TableRow><TableHead>Entity</TableHead><TableHead>Conflict</TableHead><TableHead>Evidence</TableHead><TableHead>Updated</TableHead></TableRow></TableHeader>
            <TableBody>
              {issues.map((issue) => (
                <TableRow key={`${issue.entity_type}:${issue.entity_id}:${issue.event}`}>
                  <TableCell>
                    <div className="font-medium">{issue.entity_id}</div>
                    <div className="text-xs text-muted-foreground font-mono">{issue.entity_type}</div>
                  </TableCell>
                  <TableCell className="text-sm">
                    <span className="font-mono">{issue.current_status}</span>
                    <span className="text-muted-foreground"> should be </span>
                    <span className="font-mono text-destructive">{issue.expected_status}</span>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    <div className="font-mono text-foreground">{issue.event}</div>
                    <div>{fmtNum(issue.evidence_events)} event{issue.evidence_events === 1 ? '' : 's'} · {new Date(issue.last_event_at).toLocaleString()}</div>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{new Date(issue.entity_updated_at).toLocaleString()}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ))}
    </Panel>
  );
}

const DATE_PRESETS: Array<{ v: string; label: string }> = [
  { v: '', label: 'All time' }, { v: '-24h', label: 'Last 24h' }, { v: '-7d', label: 'Last 7d' }, { v: '-30d', label: 'Last 30d' },
];
const OPS: FilterOp[] = ['eq', 'ne', 'contains', 'gt', 'gte', 'lt', 'lte', 'is_set', 'is_not_set'];
const OP_LABEL: Record<FilterOp, string> = { eq: 'is', ne: 'is not', contains: 'contains', gt: '>', gte: '≥', lt: '<', lte: '≤', in: 'is any of', is_set: 'is set', is_not_set: 'is not set' };

function EventStream({ initialEvent, initialActor, observed }: { initialEvent?: string; initialActor?: string; observed: ObservedEvent[] }) {
  const { client, project, env } = useStore();
  const [eventFilter, setEventFilter] = useState<string>(initialEvent ?? '');
  const [actorFilter, setActorFilter] = useState<string | undefined>(initialActor);
  const [props, setProps] = useState<SampleFilter[]>([]);
  const [range, setRange] = useState('');
  const [registered, setRegistered] = useState<'all' | 'reg' | 'wild'>('all');
  const [search, setSearch] = useState('');
  const [adding, setAdding] = useState(false);

  const { data, error, loading } = useAsync(
    () => client!.sample(project!, {
      env, limit: 100,
      ...(eventFilter && { event: eventFilter }),
      ...(actorFilter && { distinct_id: actorFilter }),
      ...(registered !== 'all' && { registered: registered === 'reg' }),
      ...(range && { from: range }),
      ...(props.length > 0 && { filters: props }),
    }),
    [project, env, eventFilter, actorFilter, registered, range, JSON.stringify(props)],
  );

  const q = search.trim().toLowerCase();
  const rows = (data ?? []).filter((e) => !q || `${e.event} ${e.distinct_id} ${JSON.stringify(e.properties)}`.toLowerCase().includes(q));
  const hasFilters = Boolean(eventFilter || actorFilter || props.length || range);

  return (
    <Panel title="Event stream">
      <Toolbar
        left={<SearchInput value={search} onChange={setSearch} placeholder="Search loaded events…" />}
        center={
          <>
            <Select value={eventFilter || '__all'} onValueChange={(v) => setEventFilter(v === '__all' ? '' : v)}>
              <SelectTrigger size="sm" className="w-44"><SelectValue placeholder="All events" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__all">All events</SelectItem>
                {observed.map((o) => <SelectItem key={o.event} value={o.event}>{o.event}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={range || '__all'} onValueChange={(v) => setRange(v === '__all' ? '' : v)}>
              <SelectTrigger size="sm" className="w-32"><SelectValue /></SelectTrigger>
              <SelectContent>{DATE_PRESETS.map((d) => <SelectItem key={d.v || '__all'} value={d.v || '__all'}>{d.label}</SelectItem>)}</SelectContent>
            </Select>
            <Button variant="outline" size="sm" onClick={() => setAdding((a) => !a)}><Plus className="size-3.5" /> Property</Button>
          </>
        }
        right={
          <div className="flex h-9 rounded-md border overflow-hidden text-sm">
            {(['all', 'reg', 'wild'] as const).map((v) => (
              <button key={v} onClick={() => setRegistered(v)}
                className={cn('px-3 border-r last:border-r-0', registered === v ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground')}>
                {v === 'all' ? 'all' : v === 'reg' ? 'registered' : 'off-standard'}
              </button>
            ))}
          </div>
        }
      />

      {adding && <PropertyEditor onAdd={(f) => { setProps((p) => [...p, f]); setAdding(false); }} onCancel={() => setAdding(false)} />}

      {hasFilters && (
        <div className="flex flex-wrap items-center gap-2 px-5 py-2.5 border-b">
          {eventFilter && <Chip label={`event: ${eventFilter}`} onRemove={() => setEventFilter('')} />}
          {actorFilter && <Chip label={`actor: ${actorFilter}`} onRemove={() => setActorFilter(undefined)} />}
          {range && <Chip label={DATE_PRESETS.find((d) => d.v === range)?.label ?? range} onRemove={() => setRange('')} />}
          {props.map((p, i) => <Chip key={i} label={`${p.property} ${OP_LABEL[p.op]}${p.value !== undefined ? ` ${p.value}` : ''}`} onRemove={() => setProps((arr) => arr.filter((_, j) => j !== i))} />)}
          <button className="text-xs text-primary hover:underline" onClick={() => { setEventFilter(''); setActorFilter(undefined); setRange(''); setProps([]); }}>clear all</button>
        </div>
      )}

      {loading && <Loading />}
      {error && <ErrorNote>{error}</ErrorNote>}
      {data && (rows.length === 0 ? <EmptyState headline="No events" lead={hasFilters || q ? 'nothing matches these filters' : 'nothing yet'} /> : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader><TableRow><TableHead>Event</TableHead><TableHead>Actor</TableHead><TableHead>Properties</TableHead><TableHead>When</TableHead><TableHead /></TableRow></TableHeader>
            <TableBody>
              {rows.map((e, i) => (
                <TableRow key={i}>
                  <TableCell className="font-medium">{e.event}</TableCell>
                  <TableCell><Link to={`/data/person/${encodeURIComponent(e.distinct_id)}`} className="text-xs font-mono text-primary hover:underline">{e.distinct_id}</Link></TableCell>
                  <TableCell className="text-xs text-muted-foreground max-w-sm truncate" title={JSON.stringify(e.properties)}>{JSON.stringify(e.properties)}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{new Date(e.timestamp).toLocaleString()}</TableCell>
                  <TableCell><RegBadge registered={e.registered} /></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ))}
    </Panel>
  );
}

function Chip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <Badge variant="secondary" className="gap-1 pr-1 font-mono font-normal">
      {label}<button onClick={onRemove} className="hover:text-foreground"><X className="size-3" /></button>
    </Badge>
  );
}

function PropertyEditor({ onAdd, onCancel }: { onAdd: (f: SampleFilter) => void; onCancel: () => void }) {
  const [property, setProperty] = useState('');
  const [op, setOp] = useState<FilterOp>('eq');
  const [value, setValue] = useState('');
  const needsValue = op !== 'is_set' && op !== 'is_not_set';
  const add = () => {
    if (!property.trim()) return;
    onAdd({ property: property.trim(), op, ...(needsValue ? { value } : {}) });
    setProperty(''); setValue('');
  };
  return (
    <div className="flex items-end gap-2 px-5 py-3 border-b">
      <span className="text-xs text-muted-foreground mb-2">Where</span>
      <Input className="w-40 h-9" placeholder="property" value={property} onChange={(e) => setProperty(e.target.value)} autoFocus />
      <Select value={op} onValueChange={(v) => setOp(v as FilterOp)}>
        <SelectTrigger size="sm" className="w-28"><SelectValue /></SelectTrigger>
        <SelectContent>{OPS.map((o) => <SelectItem key={o} value={o}>{OP_LABEL[o]}</SelectItem>)}</SelectContent>
      </Select>
      {needsValue && <Input className="w-40 h-9" placeholder="value" value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />}
      <Button size="sm" onClick={add} disabled={!property.trim()}>Add</Button>
      <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
    </div>
  );
}

const WARN_LABEL: Record<string, string> = { rejected: 'rejected', unregistered: 'unregistered', clock_skew: 'clock skew' };

function Warnings() {
  const { client, project, env } = useStore();
  const { data, error, loading, reload } = useAsync(() => client!.ingestWarnings(project!, { env }), [project, env]);
  const clear = async () => { await client!.clearIngestWarnings(project!, env); reload(); };
  return (
    <Panel title={<>Ingest warnings <span className="font-sans text-muted-foreground text-sm font-normal ml-2">events accepted but not fully processed</span></>}
      right={data && data.length > 0 ? <Button variant="outline" size="sm" onClick={clear}>clear</Button> : null}>
      {loading && <Loading />}
      {error && <ErrorNote>{error}</ErrorNote>}
      {data && (data.length === 0 ? <EmptyState headline="Clean" lead="no ingest warnings — every event was processed cleanly" /> : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader><TableRow><TableHead>Kind</TableHead><TableHead>Event</TableHead><TableHead>Detail</TableHead><TableHead className="text-right">Count</TableHead><TableHead>Last seen</TableHead></TableRow></TableHeader>
            <TableBody>
              {data.map((w, i) => (
                <TableRow key={i}>
                  <TableCell><Badge variant={w.kind === 'rejected' ? 'destructive' : 'secondary'}>{WARN_LABEL[w.kind]}</Badge></TableCell>
                  <TableCell className="font-medium">{w.event}</TableCell>
                  <TableCell className="text-xs text-muted-foreground max-w-md truncate" title={w.detail}>{w.detail}</TableCell>
                  <TableCell className="text-right tabular-nums">{w.count}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{new Date(w.last_seen).toLocaleString()}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ))}
    </Panel>
  );
}

const isIdentityType = (type: string, rows: EntityRow[]) => type === 'user' || rows.some((r) => 'email' in r.properties || 'name' in r.properties);

function Entities({ types }: { types: string[] }) {
  const { client, project, env } = useStore();
  const [type, setType] = useState(types[0] ?? '');
  const { data, error, loading } = useAsync(() => (type ? client!.entities(project!, { entity_type: type, limit: 100, env }) : Promise.resolve([])), [project, env, type]);

  if (types.length === 0) return <Panel><EmptyState headline="No entity types" lead="register one before upserting entities" /></Panel>;

  const rows = data ?? [];
  const identity = isIdentityType(type, rows);
  const propKeys = [...new Set(rows.flatMap((e) => Object.keys(e.properties)))].slice(0, 6);
  return (
    <Panel title="Entities">
      <Toolbar
        left={<Select value={type} onValueChange={setType}><SelectTrigger size="sm" className="w-44"><SelectValue /></SelectTrigger><SelectContent>{types.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent></Select>}
        right={identity ? <span className="text-xs text-muted-foreground">click an id to open the person</span> : null}
      />
      {loading && <Loading />}
      {error && <ErrorNote>{error}</ErrorNote>}
      {data && (rows.length === 0 ? <EmptyState headline="No entities" lead="none of this type yet" /> : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader><TableRow><TableHead>ID</TableHead>{propKeys.map((k) => <TableHead key={k}>{k}</TableHead>)}<TableHead>Updated</TableHead></TableRow></TableHeader>
            <TableBody>
              {rows.map((e) => (
                <TableRow key={e.entity_id}>
                  <TableCell className="font-medium">
                    {identity
                      ? <Link to={`/data/person/${encodeURIComponent(e.entity_id)}`} className="text-primary hover:underline">{e.entity_id}</Link>
                      : e.entity_id}
                  </TableCell>
                  {propKeys.map((k) => <TableCell key={k} className="text-xs text-muted-foreground">{fmtVal(e.properties[k])}</TableCell>)}
                  <TableCell className="text-xs text-muted-foreground">{new Date(e.updated_at).toLocaleDateString()}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ))}
    </Panel>
  );
}
