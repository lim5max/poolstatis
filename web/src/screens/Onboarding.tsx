import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, Loader2 } from '@/components/icons';
import { useStore } from '../store';
import type { DecisionLoopOnboardingStatus, HostedOnboardingResult } from '../api/types';
import { ProductConnectionGuide } from '../components/ProductConnectionGuide';
import { ErrorNote, Panel } from '../components/ui';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

const GOALS = [
  { id: 'activation', title: 'See where users get stuck', body: 'Track signup, onboarding, or another path to value.' },
  { id: 'adoption', title: 'Know which features matter', body: 'Measure whether people use the product you shipped.' },
  { id: 'release', title: 'Measure a product change', body: 'Compare a release with a real business outcome.' },
] as const;

function slugify(value: string): string {
  const cleaned = value.toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return /^[a-z]/.test(cleaned) ? cleaned : cleaned ? `p-${cleaned}` : '';
}

export function Onboarding() {
  const { client, baseUrl, refreshProjects, setProject } = useStore();
  const navigate = useNavigate();
  const [workspace, setWorkspace] = useState('My workspace');
  const [projectName, setProjectName] = useState('My product');
  const [projectSlug, setProjectSlug] = useState('my-product');
  const [goalId, setGoalId] = useState<(typeof GOALS)[number]['id']>('activation');
  const [result, setResult] = useState<HostedOnboardingResult | null>(null);
  const [status, setStatus] = useState<DecisionLoopOnboardingStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const selectedGoal = GOALS.find((goal) => goal.id === goalId) ?? GOALS[0];
  const serverUrl = (baseUrl || (import.meta.env.VITE_POOLSTATIS_API_URL as string | undefined) || 'https://api.poolstatis.xyz').replace(/\/$/, '');

  const firstEvent = status?.gates.find((gate) => gate.key === 'first_event_observed');
  const eventSeen = firstEvent?.complete ?? false;
  const lastSeen = typeof firstEvent?.evidence.last_seen === 'string' ? firstEvent.evidence.last_seen : null;

  const checkStatus = useCallback(async () => {
    if (!client || !result) return;
    setChecking(true);
    try {
      setStatus(await client.onboardingStatus(result.project.slug, 'prod'));
    } catch (error) {
      setErr((error as Error).message);
    } finally {
      setChecking(false);
    }
  }, [client, result]);

  useEffect(() => {
    if (!result || eventSeen) return;
    void checkStatus();
    const timer = window.setInterval(() => void checkStatus(), 5000);
    return () => window.clearInterval(timer);
  }, [checkStatus, eventSeen, result]);

  const submit = async () => {
    if (!client) return;
    setBusy(true);
    setErr(null);
    try {
      const created = await client.completeOnboarding({
        workspace_name: workspace.trim() || 'My workspace',
        project_name: projectName.trim(),
        project_slug: projectSlug.trim(),
      });
      setResult(created);
      setProject(created.project.slug);
      await refreshProjects();
    } catch (error) {
      setErr((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    return (
      <div className="mx-auto max-w-4xl space-y-5">
        <header>
          <div className="mb-1 text-xs text-muted-foreground">Project created · {result.project.name}</div>
          <h1 className="serif text-3xl font-normal">Connect your product</h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            Add Poolstatis, perform one real action in your product, and wait for the green confirmation. MCP is optional.
          </p>
        </header>

        <ProductConnectionGuide
          ingestKey={result.tokens.ingest_prod}
          serverUrl={serverUrl}
          projectName={result.project.name}
          projectSlug={result.project.slug}
          goal={selectedGoal.title}
          eventSeen={eventSeen}
          lastSeen={lastSeen}
          checking={checking}
          error={err}
          onCheck={() => void checkStatus()}
          onOpenProject={() => navigate('/data', { replace: true })}
        />

        {!eventSeen && (
          <div className="flex justify-end">
            <Button variant="ghost" onClick={() => navigate('/setup', { replace: true })}>Finish later</Button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <header>
        <div className="mb-1 text-xs text-muted-foreground">About 5 minutes</div>
        <h1 className="serif text-3xl font-normal">Connect your first product</h1>
        <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted-foreground">
          Name the product and choose one thing you want to learn. You can change everything later.
        </p>
      </header>

      <Panel title="What do you want to learn first?">
        <div className="grid gap-2 sm:grid-cols-3" role="group" aria-label="First analytics goal">
          {GOALS.map((goal) => (
            <button
              key={goal.id}
              type="button"
              aria-pressed={goalId === goal.id}
              onClick={() => setGoalId(goal.id)}
              className={cn(
                'rounded-md border p-3 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50',
                goalId === goal.id ? 'border-primary bg-primary/5' : 'bg-muted/15 hover:bg-accent/40',
              )}
            >
              <span className="flex items-start justify-between gap-2 text-sm font-medium">
                {goal.title}
                {goalId === goal.id && <Check className="mt-0.5 size-4 shrink-0 text-primary" />}
              </span>
              <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">{goal.body}</span>
            </button>
          ))}
        </div>

        <div className="mt-5 space-y-1.5">
          <Label htmlFor="project-name" className="text-xs font-medium text-muted-foreground">Product name</Label>
          <Input
            id="project-name"
            autoFocus
            value={projectName}
            onChange={(event) => {
              setProjectName(event.target.value);
              setProjectSlug(slugify(event.target.value));
            }}
          />
        </div>

        <details className="mt-3 rounded-md border bg-muted/10 px-3 py-2">
          <summary className="cursor-pointer text-xs text-muted-foreground">Advanced project settings</summary>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="workspace-name" className="text-xs font-medium text-muted-foreground">Workspace name</Label>
              <Input id="workspace-name" value={workspace} onChange={(event) => setWorkspace(event.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="project-slug" className="text-xs font-medium text-muted-foreground">Project slug</Label>
              <Input id="project-slug" value={projectSlug} onChange={(event) => setProjectSlug(slugify(event.target.value))} />
            </div>
          </div>
        </details>

        {err && <div className="mt-4"><ErrorNote>{err}</ErrorNote></div>}

        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
          <span className="text-xs text-muted-foreground">No MCP or agent configuration is required.</span>
          <Button onClick={submit} disabled={busy || !projectName.trim() || !projectSlug.trim()}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            {busy ? 'Creating…' : 'Create product and continue'}
          </Button>
        </div>
      </Panel>
    </div>
  );
}
