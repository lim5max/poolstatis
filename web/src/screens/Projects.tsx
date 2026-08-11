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

export function Projects() {
  const { projects, project, setProject, tokenKind, projectScope, account, client, refreshProjects } = useStore();
  const nav = useNavigate();
  const canCreate = tokenKind === 'personal'
    || (tokenKind === 'user' && (account?.membership.role === 'owner' || account?.membership.role === 'admin'));
  const open = (slug: string) => { setProject(slug); nav('/registry'); };
  const [deleteTarget, setDeleteTarget] = useState<{ slug: string; name: string } | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
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
  if (canOnboard && projects.length === 0) return <Onboarding />;

  return (
    <div className="space-y-4">
      <Panel
        title={<>Project portfolio <span className="ml-2 font-sans text-sm font-normal text-muted-foreground">{projects.length} in this {projectScope === 'project' ? 'key scope' : 'workspace'}</span></>}
        right={projectScope === 'project' ? <span className="text-xs text-muted-foreground">secret key scope</span> : null}
      >
        {projects.length > 0 && <div className="mb-4 grid grid-cols-3 overflow-hidden rounded-control border text-center"><PortfolioStat label="Healthy" value={healthy} /><PortfolioStat label="Needs attention" value={attention} /><PortfolioStat label="No data" value={noData} /></div>}
        {projects.length === 0 ? <EmptyState headline={tokenKind === 'user' ? 'No projects in this workspace' : 'No projects'} lead={tokenKind === 'user' ? 'Ask an owner or admin to create one.' : 'Create one below or use the CLI.'} /> : (
          <TableScroll><Table>
            <TableHeader>
              <TableRow><TableHead>Project</TableHead><TableHead>Health</TableHead><TableHead>Last event</TableHead><TableHead>Current usage</TableHead><TableHead>Key outcome</TableHead><TableHead>Attention</TableHead><TableHead /></TableRow>
            </TableHeader>
            <TableBody>
              {projects.map((p) => (
                <TableRow key={p.slug}>
                  <TableCell><div className="font-medium flex items-center gap-2">{p.name}{p.slug === project && <Badge className="text-xs">selected</Badge>}</div><div className="text-xs text-muted-foreground">{p.slug} · {p.timezone}</div></TableCell>
                  <TableCell><Badge variant={p.health === 'healthy' ? 'default' : 'outline'}>{p.health === 'healthy' ? 'Healthy' : p.health === 'needs_attention' ? 'Needs attention' : 'No data'}</Badge></TableCell>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{p.last_event_at ? fmtRelative(p.last_event_at) : 'Never'}</TableCell>
                  <TableCell><div className="tabular-nums">{fmtNum(p.events_30d ?? 0)} <span className="text-xs text-muted-foreground">events · 30d</span></div><div className="text-xs text-muted-foreground">{fmtNum(p.events_24h ?? 0)} · 24h / {fmtNum(p.events_7d ?? 0)} · 7d</div></TableCell>
                  <TableCell><Badge variant={p.key_outcome_available ? 'outline' : 'secondary'}>{p.key_outcome_available ? `${p.active_outcome_contracts} active contract${p.active_outcome_contracts === 1 ? '' : 's'}` : 'Unavailable'}</Badge><div className="mt-1 text-xs text-muted-foreground">{p.active_metrics} metrics · {p.funnels} funnels</div></TableCell>
                  <TableCell><div className="flex max-w-64 flex-wrap gap-1">{(p.attention ?? []).length === 0 ? <span className="text-xs text-muted-foreground">None</span> : (p.attention ?? []).slice(0, 2).map((reason) => <Badge key={reason} variant="outline" className="font-normal">{reason}</Badge>)}</div></TableCell>
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
      {canCreate && <CreateProject onCreated={async (created) => { await refreshProjects(); setProject(created.slug); }} create={(b) => client!.createProject(b)} />}
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

function CreateProject({ create, onCreated }: { create: (b: { slug: string; name: string }) => Promise<{ slug: string }>; onCreated: (project: { slug: string }) => Promise<void> }) {
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
    <Panel title="New project">
      <div className="flex flex-col gap-3.5 sm:flex-row sm:items-end">
        <div className="flex-1 space-y-1.5"><Label htmlFor="project-slug" className="text-xs font-medium text-muted-foreground">Slug</Label><Input id="project-slug" placeholder="my-app" value={slug} onChange={(e) => setSlug(e.target.value)} /></div>
        <div className="flex-1 space-y-1.5"><Label htmlFor="project-name" className="text-xs font-medium text-muted-foreground">Name</Label><Input id="project-name" placeholder="My App" value={name} onChange={(e) => setName(e.target.value)} /></div>
        <Button onClick={submit} disabled={busy || !slug.trim()}>{busy ? <><Loader2 className="size-4 animate-spin" /><span>Creating…</span></> : 'Create'}</Button>
      </div>
      {err && <div className="mt-3"><ErrorNote>{err}</ErrorNote></div>}
    </Panel>
  );
}
