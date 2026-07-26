import { useState } from 'react';
import { Add, GridView, Loader2 } from '@/components/icons';
import { useAsync, useStore } from '../store';
import { EmptyState, ErrorNote, Loading, Panel, RecoverableError, fmtNum } from '../components/ui';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { ExperienceSessionResponse, ExperienceSurface, InteractionMapResponse } from '../api/types';

export function Experience() {
  const { client, project, env } = useStore();
  const [creating, setCreating] = useState(false);
  const { data: surfaces, error, loading, reload } = useAsync(
    () => client!.experienceSurfaces(project!, env), [project, env],
  );
  if (loading) return <Loading what="reading browser experience…" />;
  if (error) return <RecoverableError onRetry={reload}>{error}</RecoverableError>;
  if (!surfaces) return null;
  return <div className="space-y-4">
    <Panel title="Browser Experience" right={<span className="text-xs text-muted-foreground">consent-gated · no DOM replay</span>}>
      <div className="grid gap-px overflow-hidden rounded-md border bg-border sm:grid-cols-2 xl:grid-cols-4">
        {[
          ['1', 'Surface', 'A stable product area such as checkout.'],
          ['2', 'Route and labels', 'Developer-provided keys, never page text.'],
          ['3', 'Consent', 'Capture starts only when your callback returns true.'],
          ['4', 'Evidence', 'Read labelled clicks and privacy-bounded known sessions.'],
        ].map(([step, title, copy]) => <div key={step} className="bg-card p-4"><div className="flex items-center gap-2"><span className="flex size-6 items-center justify-center rounded-full border text-xs">{step}</span><span className="font-medium">{title}</span></div><p className="mt-2 text-xs text-muted-foreground">{copy}</p></div>)}
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-xs text-muted-foreground">Only stable paths, developer labels, numeric click position, scroll depth, and coarse errors are accepted. No page snapshot or DOM recording is stored.</p>
        <Button onClick={() => setCreating((value) => !value)} aria-expanded={creating}><Add className="size-4" />{creating ? 'Close surface form' : 'Create capture surface'}</Button>
      </div>
    </Panel>
    {creating && <SurfaceForm onCreated={() => { setCreating(false); reload(); }} />}
    <SurfacesTable surfaces={surfaces} onChanged={reload} />
    <EvidenceExplorer surfaces={surfaces} env={env} />
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
      onCreated();
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'could not create experience surface'); }
    finally { setBusy(false); }
  };
  return <Panel title="Declare capture surface">
    <p className="mb-4 text-xs text-muted-foreground">The key must match the SDK <code>surface</code>. Purpose explains which UX decision this evidence should inform.</p>
    <div className="grid gap-3 md:grid-cols-2">
      <Field label="Surface key"><Input aria-label="Surface key" value={key} onChange={(event) => setKey(event.target.value)} placeholder="checkout" /></Field>
      <Field label="Display name"><Input aria-label="Surface name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Checkout" /></Field>
      <Field label="Decision purpose" className="md:col-span-2"><textarea aria-label="Surface purpose" value={purpose} onChange={(event) => setPurpose(event.target.value)} placeholder="Understand friction before a buyer completes checkout." className="min-h-20 w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50" /></Field>
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
    catch (caught) { setError(caught instanceof Error ? caught.message : 'could not archive surface'); }
    finally { setBusy(null); }
  };
  return <Panel title={<>Capture surfaces <span className="ml-2 font-sans text-sm font-normal text-muted-foreground">{surfaces.length}</span></>}>
    {surfaces.length === 0 ? <EmptyState headline="No capture surface yet" lead="declare one only after the product has an explicit consent path" /> : <div className="overflow-x-auto"><Table className="min-w-2xl"><TableHeader><TableRow><TableHead>Surface</TableHead><TableHead>Purpose</TableHead><TableHead>Capture status</TableHead><TableHead /></TableRow></TableHeader><TableBody>{surfaces.map((surface) => <TableRow key={surface.id}><TableCell><div className="font-medium">{surface.name}</div><code className="text-xs text-muted-foreground">{surface.key}</code></TableCell><TableCell className="max-w-lg text-sm text-muted-foreground">{surface.purpose}</TableCell><TableCell><div className={surface.status === 'active' ? 'text-xs text-emerald-600' : 'text-xs text-muted-foreground'}>{surface.status}</div><div className="mt-1 whitespace-nowrap text-xs text-muted-foreground">{surface.last_capture_at ? `Last accepted capture ${formatDate(surface.last_capture_at)}` : 'No accepted capture yet'}</div></TableCell><TableCell className="text-right"><div className="inline-flex items-center gap-2"><Button variant="link" size="sm" asChild><a href="#experience-evidence">View click / session scroll</a></Button>{surface.status === 'active' && <Button variant="outline" size="sm" disabled={busy === surface.key} onClick={() => archive(surface.key)}>{busy === surface.key && <Loader2 className="size-3.5 animate-spin" />}Archive</Button>}</div></TableCell></TableRow>)}</TableBody></Table></div>}
    {error && <div className="mt-3"><ErrorNote>{error}</ErrorNote></div>}
  </Panel>;
}

function EvidenceExplorer({ surfaces, env }: { surfaces: ExperienceSurface[]; env: string }) {
  const { client, project } = useStore();
  const [surface, setSurface] = useState('');
  const [period, setPeriod] = useState('7');
  const [grid, setGrid] = useState('16');
  const [result, setResult] = useState<InteractionMapResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selected = surface || surfaces[0]?.key || '';
  const reset = () => { setResult(null); setError(null); };
  const load = async () => {
    if (!selected) return;
    setBusy(true); setError(null); setResult(null);
    try { setResult(await client!.interactionMap(project!, { surface: selected, date_from: `-${period}d`, env, grid: Number(grid) })); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'could not load interaction evidence'); }
    finally { setBusy(false); }
  };
  return <div id="experience-evidence" className="scroll-mt-4"><Panel title="Interaction evidence" right={<span className="text-xs text-muted-foreground">accepted typed capture · {env}</span>}>
    <div className="flex flex-wrap gap-2">
      <SurfaceSelect surfaces={surfaces} selected={selected} onChange={(value) => { setSurface(value); reset(); }} />
      <Select value={period} onValueChange={(value) => { setPeriod(value); reset(); }}><SelectTrigger aria-label="Evidence period" className="h-9 w-28"><SelectValue /></SelectTrigger><SelectContent>{['7', '30', '90'].map((days) => <SelectItem key={days} value={days}>{days} days</SelectItem>)}</SelectContent></Select>
      <Select value={grid} onValueChange={(value) => { setGrid(value); reset(); }}><SelectTrigger aria-label="Map grid" className="h-9 w-24"><SelectValue /></SelectTrigger><SelectContent>{['8', '16', '32'].map((value) => <SelectItem key={value} value={value}>{value} × {value}</SelectItem>)}</SelectContent></Select>
      <Button onClick={load} disabled={!selected || busy}>{busy ? <Loader2 className="size-4 animate-spin" /> : <GridView className="size-4" />}Load evidence</Button>
    </div>
    {busy && <div className="mt-4 text-sm text-muted-foreground" role="status" aria-live="polite">Loading click evidence…</div>}
    {error && <div className="mt-3"><ErrorNote>{error}. Verify the surface, environment, consent, and accepted SDK batches.</ErrorNote></div>}
    {!result && !busy && !error && <p className="mt-4 text-sm text-muted-foreground">{surfaces.length ? 'Choose a window and load schema-accepted evidence.' : 'Create a surface before querying evidence.'}</p>}
    {result && <EvidenceResult result={result} period={period} />}
  </Panel></div>;
}

function EvidenceResult({ result, period }: { result: InteractionMapResponse; period: string }) {
  const max = Math.max(1, ...result.cells.map((cell) => cell.count));
  const cells = new Map(result.cells.map((cell) => [`${cell.x}:${cell.y}`, cell]));
  return <Tabs defaultValue="clicks" className="mt-4 gap-3" aria-live="polite">
    <div className="max-w-full overflow-x-auto"><TabsList className="w-max"><TabsTrigger value="clicks">Click map</TabsTrigger><TabsTrigger value="scroll">Scroll evidence</TabsTrigger></TabsList></div>
    <TabsContent value="clicks">
      {result.cells.length === 0 && result.labels.length === 0 ? <EmptyState headline="No captured clicks" lead={`no accepted labelled click events in the last ${period} days`} /> : <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="rounded-md border bg-muted/20 p-3"><div className="mb-2 text-xs text-muted-foreground">Normalized viewport grid · not gaze or pointer movement</div><div role="img" aria-label={`Click map: ${result.cells.reduce((sum, cell) => sum + cell.count, 0)} accepted clicks across ${result.cells.length} occupied grid cells.`} className="grid gap-0.5" style={{ gridTemplateColumns: `repeat(${result.grid}, minmax(0, 1fr))` }}>{Array.from({ length: result.grid * result.grid }, (_, index) => {
          const x = index % result.grid; const y = Math.floor(index / result.grid); const cell = cells.get(`${x}:${y}`); const opacity = cell ? Math.max(0.15, cell.count / max) : 0.04;
          return <div key={`${x}:${y}`} aria-hidden="true" title={cell ? `${cell.count} clicks · ${cell.actors} actors` : 'No click'} className="aspect-square rounded-sm bg-primary" style={{ opacity }} />;
        })}</div><ul className="sr-only">{result.cells.map((cell) => <li key={`${cell.x}:${cell.y}`}>Grid column {cell.x + 1}, row {cell.y + 1}: {cell.count} clicks, {cell.actors} actors.</li>)}</ul></div>
        <div className="overflow-x-auto"><Table><TableHeader><TableRow><TableHead>Label</TableHead><TableHead>Clicks</TableHead><TableHead>Actors</TableHead></TableRow></TableHeader><TableBody>{result.labels.map((label) => <TableRow key={label.label}><TableCell><code className="text-xs">{label.label}</code></TableCell><TableCell>{fmtNum(label.count)}</TableCell><TableCell>{fmtNum(label.actors)}</TableCell></TableRow>)}</TableBody></Table></div>
      </div>}
    </TabsContent>
    <TabsContent value="scroll">
      <EmptyState
        headline="Cross-session scroll map is not available here"
        lead={`use Known session for numeric max-scroll evidence in the current 7-day session window; screenshot-backed and versioned overlays are a separate Visual Experience Maps capability`}
      />
      <div className="mt-3 text-center"><Button variant="outline" size="sm" asChild><a href="#experience-session">Open Known session</a></Button></div>
    </TabsContent>
  </Tabs>;
}

function SessionTimeline({ surfaces, env }: { surfaces: ExperienceSurface[]; env: string }) {
  const { client, project } = useStore();
  const [surface, setSurface] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [result, setResult] = useState<ExperienceSessionResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selected = surface || surfaces[0]?.key || '';
  const load = async () => {
    if (!selected || !sessionId.trim()) return;
    setBusy(true); setError(null); setResult(null);
    try { setResult(await client!.experienceSession(project!, { surface: selected, session_id: sessionId.trim(), date_from: '-7d', env })); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'could not load session'); }
    finally { setBusy(false); }
  };
  return <div id="experience-session" className="scroll-mt-4"><Panel title="Known session" right={<span className="text-xs text-muted-foreground">privacy-safe timeline · last 7 days</span>}>
    <p className="mb-3 text-xs text-muted-foreground">Paste a session id from your product diagnostics. Poolstatis does not expose a replay browser or captured page content.</p>
    <div className="flex flex-wrap gap-2"><SurfaceSelect surfaces={surfaces} selected={selected} onChange={(value) => { setSurface(value); setResult(null); setError(null); }} /><Input aria-label="Experience session id" value={sessionId} onChange={(event) => { setSessionId(event.target.value); setResult(null); }} placeholder="session id" className="min-w-52 flex-1" /><Button onClick={load} disabled={!selected || !sessionId.trim() || busy}>{busy && <Loader2 className="size-4 animate-spin" />}Load session</Button></div>
    {busy && <div className="mt-4 text-sm text-muted-foreground" role="status" aria-live="polite">Loading session evidence…</div>}
    {error && <div className="mt-3"><ErrorNote>{error}</ErrorNote></div>}
    {result && (result.events.length === 0 ? <div className="mt-4"><EmptyState headline="Session not observed in this window" lead="check the id, surface, environment, consent, and capture delivery" /></div> : <div className="mt-4 space-y-3" aria-live="polite"><div className="grid gap-2 sm:grid-cols-4">{[['Page views', result.summary.page_views], ['Clicks', result.summary.clicks], ['Max scroll', `${result.summary.max_scroll_depth}%`], ['Client errors', result.summary.client_errors]].map(([label, value]) => <div key={String(label)} className="rounded-md border p-3"><div className="text-xs text-muted-foreground">{label}</div><div className="serif mt-1 text-2xl">{value}</div></div>)}</div><div className="overflow-x-auto"><Table><TableHeader><TableRow><TableHead>Sequence</TableHead><TableHead>Signal</TableHead><TableHead>Route</TableHead><TableHead>Detail</TableHead></TableRow></TableHeader><TableBody>{result.events.map((event) => <TableRow key={`${event.sequence}-${event.kind}`}><TableCell>{event.sequence}</TableCell><TableCell><code className="text-xs">{event.kind}</code></TableCell><TableCell><code className="text-xs">{event.route}</code></TableCell><TableCell className="text-xs text-muted-foreground">{event.label ?? (event.depth !== undefined ? `${event.depth}%` : event.error_type ?? '—')}</TableCell></TableRow>)}</TableBody></Table></div></div>)}
  </Panel></div>;
}

function SurfaceSelect({ surfaces, selected, onChange }: { surfaces: ExperienceSurface[]; selected: string; onChange: (value: string) => void }) {
  return <Select value={selected} onValueChange={onChange} disabled={surfaces.length === 0}><SelectTrigger aria-label="Experience surface" className="h-9 min-w-44"><SelectValue placeholder="Choose surface" /></SelectTrigger><SelectContent>{surfaces.map((surface) => <SelectItem key={surface.key} value={surface.key}>{surface.name} · {surface.status}</SelectItem>)}</SelectContent></Select>;
}

function Field({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return <div className={`space-y-1.5 ${className ?? ''}`}><Label>{label}</Label>{children}</div>;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}
