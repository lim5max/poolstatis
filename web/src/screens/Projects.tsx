import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2 } from '@/components/icons';
import { useStore } from '../store';
import { DangerConfirm, Panel, EmptyState, ErrorNote, fmtNum, TableScroll } from '../components/ui';
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
        title={<>Projects <span className="ml-2 font-sans text-sm font-normal text-muted-foreground">{projects.length} in this {projectScope === 'project' ? 'key scope' : 'org'}</span></>}
        right={projectScope === 'project' ? <span className="text-xs text-muted-foreground">secret key — scoped to one project</span> : null}
      >
        {projects.length === 0 ? <EmptyState headline={tokenKind === 'user' ? 'No projects in this workspace' : 'No projects'} lead={tokenKind === 'user' ? 'Ask an owner or admin to create one.' : 'Create one below or use the CLI.'} /> : (
          <TableScroll><Table>
            <TableHeader>
              <TableRow><TableHead>Project</TableHead><TableHead>Timezone</TableHead><TableHead className="text-right">Active metrics</TableHead><TableHead className="text-right">Funnels</TableHead><TableHead className="text-right">Events · 30d</TableHead><TableHead /></TableRow>
            </TableHeader>
            <TableBody>
              {projects.map((p) => (
                <TableRow key={p.slug}>
                  <TableCell><div className="font-medium flex items-center gap-2">{p.name}{p.slug === project && <Badge className="text-xs">selected</Badge>}</div><div className="text-xs text-muted-foreground">{p.slug}</div></TableCell>
                  <TableCell className="text-muted-foreground">{p.timezone}</TableCell>
                  <TableCell className="text-right tabular-nums">{p.active_metrics}</TableCell>
                  <TableCell className="text-right tabular-nums">{p.funnels}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmtNum(p.events_30d)}</TableCell>
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
