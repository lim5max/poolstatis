import { useRef, useState } from 'react';
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
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { DataHealthControl } from '../components/data-health-control';
import type {
  BackfillPreview, DataQualityIssue, EntityRow, EventRevisionPatch, EventRevisionPreview, FilterOp,
  ObservedEvent, SampleEvent, SampleFilter,
} from '../api/types';

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
  const signatureParam = params.get('signature') ?? undefined;
  const schema = useAsync(() => client!.schema(project!, env), [project, env]);
  if (schema.loading) return <Loading what="reading data…" />;
  if (schema.error) return <RecoverableError onRetry={schema.reload}>{schema.error}</RecoverableError>;
  if (!schema.data) return null;

  return (
    <Tabs value={tab} onValueChange={setTab} className="gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0 max-w-full flex-1 overflow-x-auto pb-1">
          <TabsList className="w-max">
            <TabsTrigger value="health">Data health</TabsTrigger>
            <TabsTrigger value="events">Event stream</TabsTrigger>
            <TabsTrigger value="backfill">Backfill</TabsTrigger>
            <TabsTrigger value="entities">Entities</TabsTrigger>
            <TabsTrigger value="warnings">Warnings</TabsTrigger>
          </TabsList>
        </div>
        <EnvSelect />
      </div>
      <TabsContent value="health"><Health focusedSignature={signatureParam} observed={schema.data.observed_events_30d} /></TabsContent>
      <TabsContent value="events"><EventStream initialEvent={eventParam} initialActor={actorParam} observed={schema.data.observed_events_30d} /></TabsContent>
      <TabsContent value="backfill"><BackfillManager /></TabsContent>
      <TabsContent value="entities"><Entities types={schema.data.entity_types.map((t) => t.name)} /></TabsContent>
      <TabsContent value="warnings"><Warnings /></TabsContent>
    </Tabs>
  );
}

function Health({ observed, focusedSignature }: { observed: ObservedEvent[]; focusedSignature?: string }) {
  const { client, project, env } = useStore();
  const quality = useAsync(() => client!.dataQuality(project!, { env, limit: 50 }), [project, env]);
  const events = [...observed].sort((a, b) => b.count - a.count);
  const total = events.reduce((s, e) => s + e.count, 0);
  const weighted = events.reduce((s, e) => s + e.count * e.registered_share, 0);
  const coverage = total ? weighted / total : 1;
  const wild = events.filter((e) => e.registered_share < 0.999);
  const qualityIssues = quality.loading || quality.error ? undefined : quality.data?.issues;
  const qualityChecked = quality.loading || quality.error ? undefined : quality.data?.checked;
  const issueCount = quality.error ? 'error' : quality.loading ? '…' : (qualityIssues?.length ?? 0);
  return (
    <div className="space-y-4">
      <DataHealthControl focusedSignature={focusedSignature} />
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        <Stat label="Instrumentation coverage" value={fmtPct(coverage)} sub="of 30-day volume" />
        <Stat label="Off-standard names" value={wild.length} sub="no matching active metric" />
        <Stat label="Entity conflicts" value={quality.loading ? '…' : issueCount} sub="events vs current status" />
        <Stat label="Distinct events" value={events.length} sub={`${fmtNum(total)} total · 30d`} />
      </div>
      {quality.loading && <Loading what="classifying entity consistency…" />}
      <DataQualityPanel loading={quality.loading} error={quality.error} issues={qualityIssues} checked={qualityChecked} />
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

function DataQualityPanel({
  loading,
  error,
  issues,
  checked,
}: {
  loading: boolean;
  error: string | null;
  issues?: DataQualityIssue[];
  checked?: { terminal_event_specs: number; evidence_rows: number };
}) {
  return (
    <Panel title="Entity/event consistency">
      {loading && <Loading />}
      {error && <ErrorNote>{error}</ErrorNote>}
      {issues && (issues.length === 0 ? checked?.terminal_event_specs === 0 ? (
        <EmptyState headline="Not evaluated" lead="no supported terminal entity event is registered" />
      ) : checked?.evidence_rows === 0 ? (
        <EmptyState headline="No comparable evidence" lead="terminal rules exist, but no event and current entity status could be matched" />
      ) : (
        <EmptyState headline="No conflicts" lead={`${checked?.evidence_rows ?? 0} comparable entity records match terminal events`} />
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
  const [selected, setSelected] = useState<SampleEvent | null>(null);

  const { data, error, loading, reload } = useAsync(
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
          <div className="flex h-9 rounded-field border overflow-hidden text-sm">
            {(['all', 'reg', 'wild'] as const).map((v) => (
              <button key={v} onClick={() => setRegistered(v)}
                className={cn('px-3 border-r last:border-r-0', registered === v ? 'bg-brand text-brand-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground')}>
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
          <button className="text-sm text-foreground underline decoration-muted-foreground/60 underline-offset-2 hover:decoration-foreground" onClick={() => { setEventFilter(''); setActorFilter(undefined); setRange(''); setProps([]); }}>clear all</button>
        </div>
      )}

      {loading && <Loading />}
      {error && <ErrorNote>{error}</ErrorNote>}
      {data && (rows.length === 0 ? <EmptyState headline="No events" lead={hasFilters || q ? 'nothing matches these filters' : 'nothing yet'} /> : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader><TableRow><TableHead>Event</TableHead><TableHead>Actor</TableHead><TableHead>Properties</TableHead><TableHead>When</TableHead><TableHead>Origin</TableHead><TableHead /></TableRow></TableHeader>
            <TableBody>
              {rows.map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="font-medium">{e.event}</TableCell>
                  <TableCell><Link to={`/data/person/${encodeURIComponent(e.distinct_id)}`} className="text-xs font-mono text-foreground underline decoration-muted-foreground/60 underline-offset-2 hover:decoration-foreground">{e.distinct_id}</Link></TableCell>
                  <TableCell className="text-xs text-muted-foreground max-w-sm truncate" title={JSON.stringify(e.properties)}>{JSON.stringify(e.properties)}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{new Date(e.timestamp).toLocaleString()}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {e.origin}{e.revision > 1 ? ` · rev ${e.revision}` : ''}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <RegBadge registered={e.registered} />
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setSelected(e)}
                        disabled={!e.editable}
                        title={e.editable ? 'Preview an audited correction' : 'System evidence is immutable'}
                      >
                        Correct
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ))}
      {selected && (
        <EventCorrectionDialog
          event={selected}
          onClose={() => setSelected(null)}
          onCommitted={() => { setSelected(null); reload(); }}
        />
      )}
    </Panel>
  );
}

function EventCorrectionDialog({
  event,
  onClose,
  onCommitted,
}: {
  event: SampleEvent;
  onClose: () => void;
  onCommitted: () => void;
}) {
  const { client, project, env } = useStore();
  const [timestamp, setTimestamp] = useState(event.timestamp);
  const [setProperties, setSetProperties] = useState('{}');
  const [unsetProperties, setUnsetProperties] = useState('');
  const [reason, setReason] = useState('');
  const [preview, setPreview] = useState<EventRevisionPreview | null>(null);
  const [previewPatch, setPreviewPatch] = useState<EventRevisionPatch | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const previewGeneration = useRef(0);
  const history = useAsync(
    () => client!.eventHistory(project!, event.id, env),
    [project, env, event.id],
  );

  const buildPatch = () => {
    const parsed = JSON.parse(setProperties) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Set properties must be a JSON object');
    }
    return {
      ...(timestamp !== event.timestamp ? { timestamp: new Date(timestamp).toISOString() } : {}),
      set_properties: parsed as Record<string, unknown>,
      unset_properties: unsetProperties.split(',').map((key) => key.trim()).filter(Boolean),
    };
  };
  const invalidate = () => {
    previewGeneration.current += 1;
    setPreview(null);
    setPreviewPatch(null);
    setError(null);
  };
  const runPreview = async () => {
    setBusy(true); setError(null);
    const generation = previewGeneration.current + 1;
    previewGeneration.current = generation;
    const patch = buildPatch();
    try {
      const reviewed = await client!.previewEventRevision(project!, event.id, { env, patch });
      if (generation !== previewGeneration.current) return;
      setPreview(reviewed);
      setPreviewPatch(patch);
    } catch (caught) {
      if (generation !== previewGeneration.current) return;
      setError((caught as Error).message);
    } finally {
      if (generation === previewGeneration.current) setBusy(false);
    }
  };
  const commit = async () => {
    if (!preview || !previewPatch) return;
    setBusy(true); setError(null);
    try {
      await client!.commitEventRevision(project!, event.id, {
        env,
        patch: previewPatch,
        expected_revision: preview.expected_revision,
        expected_preview_sha256: preview.preview_sha256,
        reason,
      });
      onCommitted();
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Correct event</DialogTitle>
          <DialogDescription>
            The current row is revised in analytics; Poolstatis keeps immutable before/after evidence.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="rounded-md border p-3 text-xs">
            <div className="font-medium">{event.event}</div>
            <div className="font-mono text-muted-foreground mt-1">{event.id} · revision {event.revision}</div>
          </div>
          <label className="grid gap-1.5 text-sm">
            Timestamp
            <Input value={timestamp} onChange={(e) => { setTimestamp(e.target.value); invalidate(); }} />
          </label>
          <label className="grid gap-1.5 text-sm">
            Set properties
            <textarea
              className="min-h-28 rounded-md border bg-background px-3 py-2 font-mono text-xs"
              value={setProperties}
              onChange={(e) => { setSetProperties(e.target.value); invalidate(); }}
              spellCheck={false}
            />
          </label>
          <label className="grid gap-1.5 text-sm">
            Remove properties
            <Input
              placeholder="legacy_key, wrong_parameter"
              value={unsetProperties}
              onChange={(e) => { setUnsetProperties(e.target.value); invalidate(); }}
            />
          </label>
          {preview && (
            <div className="rounded-md border p-3 text-sm">
              <div className="font-medium">Preview · revision {preview.expected_revision} → {preview.after.revision}</div>
              <div className="text-muted-foreground mt-1">{preview.changed_fields.join(', ')}</div>
              <pre className="mt-3 overflow-x-auto text-xs font-mono whitespace-pre-wrap">{JSON.stringify(preview.after, null, 2)}</pre>
            </div>
          )}
          {history.data && history.data.revisions.length > 0 && (
            <div className="rounded-md border p-3 text-sm">
              <div className="font-medium">Correction history</div>
              {history.data.revisions.map((revision) => (
                <div key={revision.id} className="mt-2 text-xs text-muted-foreground">
                  rev {revision.revision} · {revision.reason} · {new Date(revision.created_at).toLocaleString()}
                </div>
              ))}
            </div>
          )}
          <label className="grid gap-1.5 text-sm">
            Reason
            <Input
              placeholder="Why this correction is necessary"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          {error && <ErrorNote>{error}</ErrorNote>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button variant="outline" onClick={runPreview} disabled={busy}>Preview</Button>
          <Button onClick={commit} disabled={busy || !preview || !previewPatch || reason.trim().length < 10}>Apply revision</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function BackfillManager() {
  const { client, project, env } = useStore();
  const [payload, setPayload] = useState('[]');
  const [batchId, setBatchId] = useState(`historical-${new Date().toISOString().slice(0, 10)}`);
  const [reason, setReason] = useState('');
  const [preview, setPreview] = useState<BackfillPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const recent = useAsync(() => client!.backfills(project!, env), [project, env]);

  const parseEvents = (): unknown[] => {
    const parsed = JSON.parse(payload) as unknown;
    const events = Array.isArray(parsed)
      ? parsed
      : (parsed && typeof parsed === 'object' ? (parsed as { events?: unknown }).events : undefined);
    if (!Array.isArray(events)) throw new Error('Paste a JSON array or an object with an events array');
    return events;
  };
  const invalidate = () => { setPreview(null); setResult(null); setError(null); };
  const runPreview = async () => {
    setBusy(true); setError(null); setResult(null);
    try {
      setPreview(await client!.previewBackfill(project!, { env, events: parseEvents() }));
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const commit = async () => {
    if (!preview?.valid || !preview.payload_sha256) return;
    setBusy(true); setError(null);
    try {
      const imported = await client!.commitBackfill(project!, {
        env,
        batch_id: batchId,
        reason,
        expected_payload_sha256: preview.payload_sha256,
        events: parseEvents(),
      });
      setResult(imported.duplicate
        ? `Batch already stored · ${imported.batch.event_count} events`
        : `Imported ${imported.inserted} events`);
      recent.reload();
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <Panel
        title={<>Historical backfill <span className="font-sans text-sm font-normal text-muted-foreground ml-2">previewed, idempotent, source timestamps preserved</span></>}
      >
        <div className="grid gap-4">
          <label className="grid gap-1.5 text-sm">
            Events JSON
            <textarea
              className="min-h-72 rounded-md border bg-background px-3 py-2 font-mono text-xs"
              value={payload}
              onChange={(e) => { setPayload(e.target.value); invalidate(); }}
              placeholder={'[{"event":"skill.enabled","timestamp":"2026-05-20T09:00:00Z","distinct_id":"user-1","properties":{"skill":"search"}}]'}
              spellCheck={false}
            />
          </label>
          <div className="grid gap-4 md:grid-cols-2">
            <label className="grid gap-1.5 text-sm">
              Permanent batch ID
              <Input value={batchId} onChange={(e) => setBatchId(e.target.value)} />
            </label>
            <label className="grid gap-1.5 text-sm">
              Reason
              <Input
                placeholder="Source table and purpose of this import"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </label>
          </div>
          {preview && (
            <div className="rounded-md border p-3 text-sm">
              <div className="font-medium">{preview.valid ? 'Ready to import' : 'Fix validation errors'}</div>
              <div className="text-muted-foreground mt-1">
                {preview.event_count} events · {preview.registered_count} registered · {preview.unregistered_count} off-standard
              </div>
              {preview.min_timestamp && (
                <div className="text-xs text-muted-foreground mt-1">
                  {new Date(preview.min_timestamp).toLocaleString()} — {new Date(preview.max_timestamp!).toLocaleString()}
                </div>
              )}
              {preview.errors.map((item) => (
                <div key={`${item.index}:${item.message}`} className="text-xs text-destructive mt-2">
                  Event {item.index}: {item.message}
                </div>
              ))}
            </div>
          )}
          {error && <ErrorNote>{error}</ErrorNote>}
          {result && <div className="rounded-control border border-brand-strong/30 bg-primary/10 px-3 py-2 text-sm text-foreground">{result}</div>}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={runPreview} disabled={busy}>Preview</Button>
            <Button
              onClick={commit}
              disabled={busy || !preview?.valid || reason.trim().length < 10 || !batchId.trim()}
            >
              Import exact preview
            </Button>
          </div>
        </div>
      </Panel>
      <Panel title="Backfill audit">
        {recent.loading && <Loading />}
        {recent.error && <ErrorNote>{recent.error}</ErrorNote>}
        {recent.data && (recent.data.length === 0 ? (
          <EmptyState headline="No historical imports" lead="completed batches will appear here" />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader><TableRow><TableHead>Batch</TableHead><TableHead>Events</TableHead><TableHead>Range</TableHead><TableHead>Reason</TableHead><TableHead>Imported</TableHead></TableRow></TableHeader>
              <TableBody>
                {recent.data.map((batch) => (
                  <TableRow key={batch.id}>
                    <TableCell className="font-mono text-xs">{batch.batch_id}</TableCell>
                    <TableCell className="tabular-nums">{fmtNum(batch.event_count)}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {new Date(batch.min_timestamp).toLocaleDateString()} — {new Date(batch.max_timestamp).toLocaleDateString()}
                    </TableCell>
                    <TableCell className="max-w-sm text-xs">{batch.reason}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{new Date(batch.created_at).toLocaleString()}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ))}
      </Panel>
    </div>
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
                      ? <Link to={`/data/person/${encodeURIComponent(e.entity_id)}`} className="text-foreground underline decoration-muted-foreground/60 underline-offset-2 hover:decoration-foreground">{e.entity_id}</Link>
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
