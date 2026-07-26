import { useState } from 'react';
import { Add, GridView, Loader2 } from '@/components/icons';
import { useAsync, useStore } from '../store';
import { EmptyState, ErrorNote, Loading, Panel, RecoverableError } from '../components/ui';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { ExperienceSessionResponse, ExperienceSurface, InteractionMapResponse } from '../api/types';

export function Experience() {
  const { client, project, env } = useStore();
  const { data: surfaces, error, loading, reload } = useAsync(
    () => client!.experienceSurfaces(project!), [project],
  );
  if (loading) return <Loading what="reading browser experience…" />;
  if (error) return <RecoverableError onRetry={reload}>{error}</RecoverableError>;
  if (!surfaces) return null;
  return <div className="space-y-4">
    <Panel title="Browser Experience" right={<span className="text-xs text-muted-foreground">consent-gated timeline + click map</span>}>
      <p className="max-w-3xl text-sm text-muted-foreground">Records labelled clicks, scroll milestones, and coarse client errors. It is not DOM replay or eye tracking.</p>
    </Panel>
    <SurfaceForm onCreated={reload} />
    <SurfacesTable surfaces={surfaces} onChanged={reload} />
    <InteractionMap surfaces={surfaces} env={env} />
    <SessionTimeline surfaces={surfaces} env={env} />
  </div>;
}

function SurfaceForm({ onCreated }: { onCreated: () => void }) {
  const { client, project } = useStore();
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [purpose, setPurpose] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = /^[a-z][a-z0-9_]*$/.test(key.trim()) && name.trim().length > 0 && purpose.trim().length >= 10;
  const submit = async () => {
    setBusy(true); setError(null);
    try {
      await client!.createExperienceSurface(project!, { key: key.trim(), name: name.trim(), purpose: purpose.trim() });
      setKey(''); setName(''); setPurpose(''); onCreated();
    } catch (err) { setError(err instanceof Error ? err.message : 'could not create experience surface'); }
    finally { setBusy(false); }
  };
  return <Panel title="New capture surface">
    <div className="grid gap-3 md:grid-cols-2">
      <Field label="Key"><Input aria-label="Surface key" value={key} onChange={(event) => setKey(event.target.value)} placeholder="checkout" /></Field>
      <Field label="Name"><Input aria-label="Surface name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Checkout" /></Field>
      <Field label="Purpose" className="md:col-span-2"><textarea aria-label="Surface purpose" value={purpose} onChange={(event) => setPurpose(event.target.value)} placeholder="Understand friction before a buyer completes checkout." className="min-h-20 w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50" /></Field>
    </div>
    <div className="mt-4 flex justify-end"><Button onClick={submit} disabled={!valid || busy}>{busy ? <Loader2 className="size-4 animate-spin" /> : <Add className="size-4" />}Create surface</Button></div>
    {error && <div className="mt-3"><ErrorNote>{error}</ErrorNote></div>}
  </Panel>;
}

function SurfacesTable({ surfaces, onChanged }: { surfaces: ExperienceSurface[]; onChanged: () => void }) {
  const { client, project } = useStore();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const archive = async (key: string) => {
    setBusy(key); setError(null);
    try { await client!.archiveExperienceSurface(project!, key); onChanged(); }
    catch (err) { setError(err instanceof Error ? err.message : 'could not archive surface'); }
    finally { setBusy(null); }
  };
  return <Panel title={<>Capture surfaces <span className="ml-2 font-sans text-sm font-normal text-muted-foreground">{surfaces.length}</span></>}>
    {surfaces.length === 0 ? <EmptyState headline="No surfaces" lead="declare a purpose before enabling the BrowserExperience module" /> : <div className="overflow-x-auto"><Table><TableHeader><TableRow><TableHead>Surface</TableHead><TableHead>Purpose</TableHead><TableHead>Status</TableHead><TableHead /></TableRow></TableHeader><TableBody>{surfaces.map((surface) => <TableRow key={surface.id}><TableCell><div className="font-medium">{surface.name}</div><code className="text-xs text-muted-foreground">{surface.key}</code></TableCell><TableCell className="max-w-lg text-sm text-muted-foreground">{surface.purpose}</TableCell><TableCell><span className={surface.status === 'active' ? 'text-xs text-emerald-600' : 'text-xs text-muted-foreground'}>{surface.status}</span></TableCell><TableCell className="text-right">{surface.status === 'active' && <Button variant="outline" size="sm" disabled={busy === surface.key} onClick={() => archive(surface.key)}>{busy === surface.key && <Loader2 className="size-3.5 animate-spin" />}Archive</Button>}</TableCell></TableRow>)}</TableBody></Table></div>}
    {error && <div className="mt-3"><ErrorNote>{error}</ErrorNote></div>}
  </Panel>;
}

function InteractionMap({ surfaces, env }: { surfaces: ExperienceSurface[]; env: string }) {
  const { client, project } = useStore();
  const [surface, setSurface] = useState('');
  const [grid, setGrid] = useState('16');
  const [result, setResult] = useState<InteractionMapResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selected = surface || surfaces[0]?.key || '';
  const changeSurface = (value: string) => { setSurface(value); setResult(null); setError(null); };
  const changeGrid = (value: string) => { setGrid(value); setResult(null); setError(null); };
  const load = async () => {
    if (!selected) return;
    setBusy(true); setError(null); setResult(null);
    try { setResult(await client!.interactionMap(project!, { surface: selected, date_from: '-7d', env, grid: Number(grid) })); }
    catch (err) { setError(err instanceof Error ? err.message : 'could not load interaction map'); }
    finally { setBusy(false); }
  };
  return <Panel title="Interaction map" right={<span className="text-xs text-muted-foreground">last 7 days · clicks only</span>}>
    <QueryControls surfaces={surfaces} selected={selected} onSurface={changeSurface} right={<Select value={grid} onValueChange={changeGrid}><SelectTrigger className="h-9 w-24"><SelectValue /></SelectTrigger><SelectContent>{['8', '16', '32'].map((value) => <SelectItem key={value} value={value}>{value} × {value}</SelectItem>)}</SelectContent></Select>} button={<Button onClick={load} disabled={!selected || busy}>{busy ? <Loader2 className="size-4 animate-spin" /> : <GridView className="size-4" />}Load map</Button>} />
    {error && <div className="mt-3"><ErrorNote>{error}</ErrorNote></div>}
    {result && <MapResult result={result} />}
  </Panel>;
}

function MapResult({ result }: { result: InteractionMapResponse }) {
  const max = Math.max(1, ...result.cells.map((cell) => cell.count));
  const cells = new Map(result.cells.map((cell) => [`${cell.x}:${cell.y}`, cell]));
  return <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
    <div className="rounded-md border bg-muted/20 p-3"><div className="mb-2 text-xs text-muted-foreground">Surface {result.surface.key} · last 7 days · normalized viewport grid</div><div className="grid gap-0.5" style={{ gridTemplateColumns: `repeat(${result.grid}, minmax(0, 1fr))` }}>{Array.from({ length: result.grid * result.grid }, (_, index) => {
      const x = index % result.grid; const y = Math.floor(index / result.grid); const cell = cells.get(`${x}:${y}`); const opacity = cell ? Math.max(0.15, cell.count / max) : 0.04;
      return <div key={`${x}:${y}`} title={cell ? `${cell.count} clicks · ${cell.actors} actors` : 'No click'} className="aspect-square rounded-sm bg-primary" style={{ opacity }} />;
    })}</div></div>
    <div><div className="mb-2 text-xs font-medium text-muted-foreground">Labelled clicks</div>{result.labels.length === 0 ? <div className="text-sm text-muted-foreground">No captured clicks in this window.</div> : <div className="space-y-2">{result.labels.map((label) => <div key={label.label} className="flex items-center justify-between gap-2 text-sm"><code className="truncate text-xs">{label.label}</code><span className="shrink-0 text-muted-foreground">{label.count} / {label.actors}</span></div>)}</div>}</div>
  </div>;
}

function SessionTimeline({ surfaces, env }: { surfaces: ExperienceSurface[]; env: string }) {
  const { client, project } = useStore();
  const [surface, setSurface] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [result, setResult] = useState<ExperienceSessionResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selected = surface || surfaces[0]?.key || '';
  const changeSurface = (value: string) => { setSurface(value); setResult(null); setError(null); };
  const changeSessionId = (value: string) => { setSessionId(value); setResult(null); setError(null); };
  const load = async () => {
    if (!selected || !sessionId.trim()) return;
    setBusy(true); setError(null); setResult(null);
    try { setResult(await client!.experienceSession(project!, { surface: selected, session_id: sessionId.trim(), date_from: '-7d', env })); }
    catch (err) { setError(err instanceof Error ? err.message : 'could not load session'); }
    finally { setBusy(false); }
  };
  return <Panel title="Session timeline" right={<span className="text-xs text-muted-foreground">known session id · no DOM replay</span>}>
    <div className="flex flex-wrap gap-2"><QueryControls surfaces={surfaces} selected={selected} onSurface={changeSurface} /><Input value={sessionId} onChange={(event) => changeSessionId(event.target.value)} placeholder="session id" className="min-w-52 flex-1" /><Button onClick={load} disabled={!selected || !sessionId.trim() || busy}>{busy && <Loader2 className="size-4 animate-spin" />}Load session</Button></div>
    {error && <div className="mt-3"><ErrorNote>{error}</ErrorNote></div>}
    {result && <div className="mt-4 space-y-3"><div className="text-xs text-muted-foreground">Surface {result.surface.key} · session <code>{result.session_id}</code> · last 7 days</div><div className="grid gap-2 sm:grid-cols-4">{[['Page views', result.summary.page_views], ['Clicks', result.summary.clicks], ['Max scroll', `${result.summary.max_scroll_depth}%`], ['Client errors', result.summary.client_errors]].map(([label, value]) => <div key={String(label)} className="rounded-md border p-3"><div className="text-xs text-muted-foreground">{label}</div><div className="serif mt-1 text-2xl">{value}</div></div>)}</div><div className="overflow-x-auto"><Table><TableHeader><TableRow><TableHead>Sequence</TableHead><TableHead>Signal</TableHead><TableHead>Route</TableHead><TableHead>Detail</TableHead></TableRow></TableHeader><TableBody>{result.events.map((event) => <TableRow key={`${event.sequence}-${event.kind}`}><TableCell>{event.sequence}</TableCell><TableCell><code className="text-xs">{event.kind}</code></TableCell><TableCell><code className="text-xs">{event.route}</code></TableCell><TableCell className="text-xs text-muted-foreground">{event.label ?? (event.depth !== undefined ? `${event.depth}%` : event.error_type ?? '—')}</TableCell></TableRow>)}</TableBody></Table></div></div>}
  </Panel>;
}

function QueryControls({ surfaces, selected, onSurface, right, button }: { surfaces: ExperienceSurface[]; selected: string; onSurface: (value: string) => void; right?: React.ReactNode; button?: React.ReactNode }) {
  return <div className="flex flex-wrap gap-2"><Select value={selected} onValueChange={onSurface} disabled={surfaces.length === 0}><SelectTrigger className="h-9 min-w-44"><SelectValue placeholder="Choose surface" /></SelectTrigger><SelectContent>{surfaces.map((surface) => <SelectItem key={surface.key} value={surface.key}>{surface.name} · {surface.status}</SelectItem>)}</SelectContent></Select>{right}{button}</div>;
}

function Field({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return <div className={`space-y-1.5 ${className ?? ''}`}><Label>{label}</Label>{children}</div>;
}
