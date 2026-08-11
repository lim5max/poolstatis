import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2 } from '@/components/icons';
import { useStore } from '../store';
import { DangerConfirm, Panel, EmptyState, ErrorNote, fmtNum, fmtRelative, TableScroll } from '../components/ui';
import { Onboarding } from './Onboarding';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DisclosureSummary } from '@/components/disclosure';
import type { ProjectWithStats, SemanticProjectComparison } from '../api/types';

export function Projects() {
  const { projects, project, setProject, tokenKind, projectScope, account, client, refreshProjects, env } = useStore();
  const nav = useNavigate();
  const canCreate = tokenKind === 'personal'
    || (tokenKind === 'user' && (account?.membership.role === 'owner' || account?.membership.role === 'admin'));
  const open = (slug: string) => { setProject(slug); nav('/registry'); };
  const [deleteTarget, setDeleteTarget] = useState<{ slug: string; name: string } | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const healthy = projects.filter((item) => item.health === 'healthy').length;
  const attention = projects.filter((item) => item.health === 'needs_attention').length;
  const noData = projects.filter((item) => item.health === 'no_data').length;

  const remove = async () => {
    if (!deleteTarget || !client) return;
    setDeleteError(null);
    try {
      await client.deleteProject(deleteTarget.slug, deleteTarget.slug);
      setDeleteTarget(null);
      await refreshProjects();
    } catch (error) {
      setDeleteError((error as Error).message);
    }
  };

  const canOnboard = tokenKind === 'user' && (account?.membership.role === 'owner' || account?.membership.role === 'admin');
  const canCompare = projectScope === 'org'
    && projects.length >= 2
    && (tokenKind === 'personal'
      || (tokenKind === 'user' && (account?.membership.role === 'owner' || account?.membership.role === 'admin')));
  if (canOnboard && projects.length === 0) return <Onboarding />;

  return (
    <div className="space-y-4">
      <Panel
        title={<>Project portfolio <span className="ml-2 font-sans text-sm font-normal text-muted-foreground">{projects.length} in this {projectScope === 'project' ? 'key scope' : 'workspace'}</span></>}
        right={(
          <div className="flex items-center gap-2">
            {projectScope === 'project' && <span className="text-xs text-muted-foreground">secret key scope</span>}
            {canCreate && client && <Button size="sm" onClick={() => setCreateOpen(true)}>New project</Button>}
          </div>
        )}
      >
        {projects.length > 0 && <div className="mb-4 grid grid-cols-3 overflow-hidden rounded-control border text-center"><PortfolioStat label="Healthy" value={healthy} /><PortfolioStat label="Needs attention" value={attention} /><PortfolioStat label="No data" value={noData} /></div>}
        {projects.length === 0 ? <EmptyState headline={tokenKind === 'user' ? 'No projects in this workspace' : 'No projects'} lead={tokenKind === 'user' ? 'Ask an owner or admin to create one.' : 'Use New project above or create one with the CLI.'} /> : (
          <TableScroll><Table>
            <TableHeader>
              <TableRow><TableHead>Project</TableHead><TableHead>Health</TableHead><TableHead>Last event</TableHead><TableHead>Current usage</TableHead><TableHead>Key outcome</TableHead><TableHead>Attention</TableHead><TableHead /></TableRow>
            </TableHeader>
            <TableBody>
              {projects.map((p) => (
                <TableRow key={p.slug}>
                  <TableCell><div className="font-medium flex items-center gap-2">{p.name}{p.slug === project && <Badge className="text-xs">selected</Badge>}</div><div className="text-xs text-muted-foreground">{p.slug} · {p.timezone}</div></TableCell>
                  <TableCell>
                    <Badge variant={p.health === 'healthy' ? 'default' : 'outline'}>{p.health === 'healthy' ? 'Healthy' : p.health === 'needs_attention' ? 'Needs attention' : 'No data'}</Badge>
                    <ProjectHealthDetails evaluation={p.health_evaluation} />
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{p.last_event_at ? fmtRelative(p.last_event_at) : 'Never'}</TableCell>
                  <TableCell><div className="tabular-nums">{fmtNum(p.events_30d ?? 0)} <span className="text-xs text-muted-foreground">events · 30d</span></div><div className="text-xs text-muted-foreground">{fmtNum(p.events_24h ?? 0)} · 24h / {fmtNum(p.events_7d ?? 0)} · 7d</div></TableCell>
                  <TableCell><Badge variant={p.key_outcome_available ? 'outline' : 'secondary'}>{p.key_outcome_available ? `${p.active_outcome_contracts} active contract${p.active_outcome_contracts === 1 ? '' : 's'}` : 'Unavailable'}</Badge><div className="mt-1 text-xs text-muted-foreground">{p.active_metrics} metrics · {p.funnels} funnels</div></TableCell>
                  <TableCell>{(p.attention ?? []).length === 0 ? <span className="text-xs text-muted-foreground">None</span> : <div className="max-w-64"><div className="mb-1 text-xs text-muted-foreground">{p.attention.length} attention item{p.attention.length === 1 ? '' : 's'}</div><div className="flex flex-wrap gap-1">{p.attention.slice(0, 2).map((reason) => <Badge key={reason} variant="outline" className="font-normal">{reason}</Badge>)}</div></div>}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="sm" onClick={() => open(p.slug)} aria-label={`Open ${p.name}`}>Open</Button>
                      {canCreate && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive hover:text-destructive"
                          onClick={() => { setDeleteError(null); setDeleteTarget({ slug: p.slug, name: p.name }); }}
                          aria-label={`Delete ${p.name}`}
                        >Delete</Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table></TableScroll>
        )}
      </Panel>
      {canCompare && client && <ProjectComparison projects={projects} env={env} compare={(input) => client.compareProjects(input)} />}
      {createOpen && canCreate && client && (
        <CreateProject
          onCancel={() => setCreateOpen(false)}
          onCreated={async (created) => { await refreshProjects(); setProject(created.slug); setCreateOpen(false); }}
          create={(body) => client.createProject(body)}
        />
      )}
      {deleteTarget && (
        <DangerConfirm
          title={`Delete ${deleteTarget.name}?`}
          blastRadius="The project and its data will be permanently removed."
          willDelete={['Events and entities', 'Metrics, funnels, and keys', 'Setup and decision history']}
          willKeep={['Workspace and members', 'Other projects']}
          error={deleteError}
          matchValue={deleteTarget.slug}
          matchLabel="Type the project slug"
          confirmLabel="Delete project"
          onConfirm={remove}
          onCancel={() => { setDeleteTarget(null); setDeleteError(null); }}
        />
      )}
    </div>
  );
}

function PortfolioStat({ label, value }: { label: string; value: number }) {
  return <div className="border-r p-3 last:border-r-0"><div className="text-xs text-muted-foreground">{label}</div><div className="mt-1 text-xl font-semibold tabular-nums">{value}</div></div>;
}

function ProjectHealthDetails({ evaluation }: { evaluation: ProjectWithStats['health_evaluation'] | undefined }) {
  if (!evaluation) return <div className="mt-1 text-xs text-muted-foreground">Server guardrails unavailable</div>;
  return (
    <details className="mt-1 max-w-64 text-xs text-muted-foreground">
      <DisclosureSummary className="cursor-pointer underline decoration-muted-foreground/60 underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {evaluation.guardrails.length} server guardrails
      </DisclosureSummary>
      <ul className="mt-2 space-y-2 rounded-md border p-2">
        {evaluation.guardrails.map((guardrail) => (
          <li key={guardrail.id}>
            <div className="font-medium text-foreground">{guardrail.expectation}</div>
            <div>{guardrail.state === 'not_applicable' ? 'Not applicable' : guardrail.state === 'pass' ? 'Pass' : 'Needs attention'} · {formatGuardrailObserved(guardrail)}</div>
          </li>
        ))}
      </ul>
    </details>
  );
}

function formatGuardrailObserved(guardrail: ProjectWithStats['health_evaluation']['guardrails'][number]): string {
  if (guardrail.observed === null) return 'Observed unavailable';
  if (guardrail.id === 'registered_coverage') return `Observed ${Math.round(guardrail.observed * 100)}%`;
  return `Observed ${fmtNum(guardrail.observed)}`;
}

function ProjectComparison({
  projects,
  env,
  compare,
}: {
  projects: Array<{ slug: string; name: string }>;
  env: string;
  compare: (input: {
    metric_key: string;
    projects: string[];
    environment: string;
    window: { from: string; to: string };
  }) => Promise<SemanticProjectComparison>;
}) {
  const [metricKey, setMetricKey] = useState('');
  const [selected, setSelected] = useState(() => new Set(projects.slice(0, 8).map((item) => item.slug)));
  const [result, setResult] = useState<SemanticProjectComparison | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggleProject = (slug: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(slug)) next.delete(slug);
      else if (next.size < 8) next.add(slug);
      return next;
    });
    setResult(null);
  };
  const run = async () => {
    const to = new Date();
    const from = new Date(to.getTime() - 30 * 86_400_000);
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await compare({
        metric_key: metricKey.trim(),
        projects: projects.filter((item) => selected.has(item.slug)).map((item) => item.slug),
        environment: env,
        window: { from: from.toISOString(), to: to.toISOString() },
      }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Project comparison failed.');
    } finally {
      setBusy(false);
    }
  };
  const ready = selected.size >= 2 && metricKey.trim().length > 0;

  return (
    <Panel title="Compare project semantics" right={<span className="text-xs text-muted-foreground">{env} · last 30 days · UTC</span>}>
      <div className="space-y-4" id="comparison-evidence">
        <div className="grid gap-3 lg:grid-cols-[minmax(12rem,1fr)_minmax(18rem,2fr)_auto] lg:items-end">
          <div className="space-y-1.5">
            <Label htmlFor="comparison-metric-key" className="text-xs font-medium text-muted-foreground">Metric key</Label>
            <Input id="comparison-metric-key" value={metricKey} onChange={(event) => { setMetricKey(event.target.value); setResult(null); }} placeholder="activated_users" />
          </div>
          <fieldset className="min-w-0">
            <legend className="mb-1.5 text-xs font-medium text-muted-foreground">Projects · choose 2–8</legend>
            <div className="flex max-h-24 flex-wrap gap-2 overflow-y-auto rounded-md border p-2">
              {projects.map((item) => (
                <label key={item.slug} className="flex min-h-8 cursor-pointer items-center gap-2 rounded-md px-2 text-sm hover:bg-accent">
                  <input type="checkbox" checked={selected.has(item.slug)} onChange={() => toggleProject(item.slug)} />
                  <span>{item.name}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <Button onClick={run} disabled={!ready || busy}>{busy && <Loader2 className="size-4 animate-spin" />}Compare projects</Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Values are shown only when key, purpose, type, aggregation and semantic fingerprint match in every selected project.
        </p>
        {error && <ErrorNote>{error}</ErrorNote>}
        {result?.state === 'unavailable' && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-4">
            <div className="font-medium">Comparison unavailable</div>
            <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
              {result.incompatibilities.map((item, index) => <li key={`${item.project_slug}:${item.code}:${index}`}><span className="font-medium text-foreground">{item.project_slug}</span> — {item.message}</li>)}
            </ul>
            <Button asChild className="mt-4"><a href={result.primary_action.href}>{result.primary_action.label}</a></Button>
          </div>
        )}
        {result?.state === 'ready' && (
          <TableScroll testId="project-comparison-scroll"><Table>
            <TableHeader><TableRow><TableHead>Project</TableHead><TableHead className="text-right">Value</TableHead><TableHead className="text-right">Events</TableHead><TableHead className="text-right">Actors</TableHead><TableHead className="text-right">Registered</TableHead></TableRow></TableHeader>
            <TableBody>{result.projects.map((item) => <TableRow key={item.slug}>
              <TableCell><div className="font-medium">{item.name}</div><code className="text-xs text-muted-foreground">{item.slug}</code></TableCell>
              <TableCell className="text-right tabular-nums">{fmtNum(item.value ?? 0)}</TableCell>
              <TableCell className="text-right tabular-nums">{fmtNum(item.events ?? 0)}</TableCell>
              <TableCell className="text-right tabular-nums">{fmtNum(item.actors ?? 0)}</TableCell>
              <TableCell className="text-right tabular-nums">{Math.round((item.registered_coverage ?? 0) * 100)}%</TableCell>
            </TableRow>)}</TableBody>
          </Table></TableScroll>
        )}
      </div>
    </Panel>
  );
}

function CreateProject({ create, onCreated, onCancel }: {
  create: (body: { slug: string; name: string }) => Promise<{ slug: string }>;
  onCreated: (project: { slug: string }) => Promise<void>;
  onCancel: () => void;
}) {
  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true); setErr(null);
    try { const created = await create({ slug: slug.trim(), name: name.trim() || slug.trim() }); setSlug(''); setName(''); await onCreated(created); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="serif text-xl font-normal">New project</DialogTitle>
          <DialogDescription>Create a separate analytics boundary with its own registry, data, and keys.</DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          <div className="space-y-1.5"><Label htmlFor="project-slug" className="text-xs font-medium text-muted-foreground">Slug</Label><Input id="project-slug" placeholder="my-app" value={slug} onChange={(event) => setSlug(event.target.value)} /></div>
          <div className="space-y-1.5"><Label htmlFor="project-name" className="text-xs font-medium text-muted-foreground">Name</Label><Input id="project-name" placeholder="My App" value={name} onChange={(event) => setName(event.target.value)} /></div>
          {err && <ErrorNote>{err}</ErrorNote>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>Cancel</Button>
            <Button type="submit" disabled={busy || !slug.trim()}>{busy ? <><Loader2 className="size-4 animate-spin" /><span>Creating…</span></> : 'Create project'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
