import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Check, Loader2 } from '@/components/icons';
import { useStore } from '../store';
import type { DecisionLoopOnboardingStatus, HostedOnboardingResult } from '../api/types';
import {
  ProductConnectionGuide,
  type AgentId,
  type SetupTaskResponse,
} from '../components/ProductConnectionGuide';
import { ErrorNote } from '../components/ui';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

type ProjectMode = 'website' | 'product' | 'both';
type GoalId =
  | 'website_traffic' | 'website_pages' | 'website_conversion'
  | 'campaigns_referrals' | 'content_engagement' | 'activation'
  | 'feature_adoption' | 'retention' | 'release'
  | 'reliability_performance' | 'custom';

interface IntentOnboardingBody {
  workspace_name: string;
  project_name: string;
  project_slug: string;
  project_mode: ProjectMode;
  goal_ids: GoalId[];
  custom_goal: string | null;
  primary_goal_id: GoalId;
  website_domain: string | null;
}

interface IntentOnboardingClient {
  completeOnboarding(body: IntentOnboardingBody): Promise<HostedOnboardingResult>;
  onboardingStatus(slug: string, env?: string): Promise<DecisionLoopOnboardingStatus>;
  setupTask(slug: string, body: { agent_id: AgentId; prefer_llm?: boolean }): Promise<SetupTaskResponse>;
}

const MODES: Array<{ id: ProjectMode; title: string; body: string }> = [
  { id: 'website', title: 'A website', body: 'Traffic, pages, sources, and conversion.' },
  { id: 'product', title: 'A product', body: 'Activation, features, retention, and releases.' },
  { id: 'both', title: 'Both', body: 'Connect acquisition to product outcomes.' },
];

const GOALS: Record<ProjectMode, Array<{ id: GoalId; title: string }>> = {
  website: [
    { id: 'website_traffic', title: 'See who visits my website' },
    { id: 'website_pages', title: 'Know which pages work' },
    { id: 'website_conversion', title: 'Improve signup or lead conversion' },
    { id: 'campaigns_referrals', title: 'Understand campaigns and referrals' },
    { id: 'content_engagement', title: 'Measure content engagement' },
  ],
  product: [
    { id: 'activation', title: 'Find where users get stuck' },
    { id: 'feature_adoption', title: 'Know which features matter' },
    { id: 'retention', title: 'Understand retention' },
    { id: 'release', title: 'Measure a release or experiment' },
    { id: 'reliability_performance', title: 'Track reliability or performance' },
  ],
  both: [
    { id: 'website_traffic', title: 'Understand website traffic' },
    { id: 'website_conversion', title: 'Improve website conversion' },
    { id: 'activation', title: 'Find where users get stuck' },
    { id: 'feature_adoption', title: 'Know which features matter' },
    { id: 'retention', title: 'Understand retention' },
    { id: 'release', title: 'Measure a release or experiment' },
  ],
};

function slugify(value: string): string {
  const cleaned = value.toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return /^[a-z]/.test(cleaned) ? cleaned : cleaned ? `p-${cleaned}` : '';
}

function normalizedDomain(value: string): string | null {
  const domain = value.trim().toLowerCase();
  if (!domain) return null;
  if (domain.length > 253 || domain.includes('://') || /[/?#@]/.test(domain)) return null;
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(domain)) return null;
  return domain;
}

function evidenceText(evidence: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    if (typeof evidence[key] === 'string' && evidence[key]) return evidence[key] as string;
  }
  return null;
}

export function Onboarding() {
  const { account, client, baseUrl, refreshProjects, setProject } = useStore();
  const navigate = useNavigate();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [workspace] = useState(account?.organization.name ?? 'My workspace');
  const [stage, setStage] = useState<'mode' | 'goals'>('mode');
  const [mode, setMode] = useState<ProjectMode | null>(null);
  const [projectName, setProjectName] = useState('My project');
  const [projectSlug, setProjectSlug] = useState('my-project');
  const [domain, setDomain] = useState('');
  const [goalIds, setGoalIds] = useState<GoalId[]>([]);
  const [customGoal, setCustomGoal] = useState('');
  const [result, setResult] = useState<HostedOnboardingResult | null>(null);
  const [status, setStatus] = useState<DecisionLoopOnboardingStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const serverUrl = (baseUrl || (import.meta.env.VITE_POOLSTATIS_API_URL as string | undefined) || 'https://api.poolstatis.xyz').replace(/\/$/, '');
  const onboardingClient = client as unknown as IntentOnboardingClient | null;

  const firstEvent = status?.gates.find((gate) => gate.key === 'first_event_observed');
  const eventSeen = firstEvent?.complete ?? false;
  const eventEvidence = firstEvent?.evidence ?? {};
  const lastSeen = evidenceText(eventEvidence, 'last_seen', 'observed_at');
  const eventName = evidenceText(eventEvidence, 'event_name', 'event');
  const eventEnvironment = evidenceText(eventEvidence, 'environment', 'env') ?? 'prod';
  const eventRegistered = typeof eventEvidence.registered === 'boolean'
    ? eventEvidence.registered
    : eventEvidence.unregistered === true
      ? false
      : null;
  const selectedMode = mode ?? 'product';
  const customSelected = goalIds.includes('custom');
  const customError = customSelected && customGoal.trim().length < 10
    ? 'Describe your goal in at least 10 characters.'
    : null;
  const domainError = domain.trim() && !normalizedDomain(domain)
    ? 'Enter a hostname only, for example example.com.'
    : null;
  const canCreate = goalIds.length >= 1 && goalIds.length <= 3 && !customError;

  useEffect(() => {
    if (!result) headingRef.current?.focus();
  }, [stage, result]);

  const checkStatus = useCallback(async () => {
    if (!onboardingClient || !result) return;
    setChecking(true);
    try {
      setStatus(await onboardingClient.onboardingStatus(result.project.slug, 'prod'));
      setErr(null);
    } catch (error) {
      setErr((error as Error).message);
    } finally {
      setChecking(false);
    }
  }, [onboardingClient, result]);

  const getSetupTask = useCallback((agentId: AgentId) => {
    if (!onboardingClient || !result) return Promise.reject(new Error('Setup task generation is unavailable.'));
    return onboardingClient.setupTask(result.project.slug, {
      agent_id: agentId,
      prefer_llm: customSelected,
    });
  }, [customSelected, onboardingClient, result]);

  useEffect(() => {
    if (!result || eventSeen) return;
    void checkStatus();
    const timer = window.setInterval(() => void checkStatus(), 5000);
    return () => window.clearInterval(timer);
  }, [checkStatus, eventSeen, result]);

  const availableGoals = useMemo(() => mode ? GOALS[mode] : [], [mode]);

  const toggleGoal = (goalId: GoalId) => {
    setGoalIds((current) => {
      if (current.includes(goalId)) return current.filter((item) => item !== goalId);
      if (current.length === 3) return current;
      return [...current, goalId];
    });
  };

  const submit = async () => {
    if (!onboardingClient || !mode || !canCreate) return;
    setBusy(true);
    setErr(null);
    try {
      const created = await onboardingClient.completeOnboarding({
        workspace_name: workspace.trim() || 'My workspace',
        project_name: projectName.trim(),
        project_slug: projectSlug.trim(),
        project_mode: mode,
        goal_ids: goalIds,
        custom_goal: customSelected ? customGoal.trim() : null,
        primary_goal_id: goalIds[0]!,
        website_domain: mode === 'product' ? null : normalizedDomain(domain),
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

  const successRoute = selectedMode === 'website'
    ? '/analyze/web'
    : selectedMode === 'product'
      ? '/analyze/product'
      : '/';

  if (result) {
    return (
      <div className="mx-auto max-w-3xl space-y-5">
        <header>
          <div className="mb-1 text-xs text-muted-foreground">{result.project.name} · prod</div>
          <h1 className="serif text-3xl font-normal">Connect your first project</h1>
          <p className="mt-2 max-w-xl text-sm text-muted-foreground">
            Tell us what you want to understand. Your agent will handle the setup.
          </p>
        </header>

        <ProductConnectionGuide
          ingestKey={result.tokens.ingest_prod}
          serverUrl={serverUrl}
          projectName={result.project.name}
          projectSlug={result.project.slug}
          projectMode={selectedMode}
          eventSeen={eventSeen}
          lastSeen={lastSeen}
          eventName={eventName}
          eventEnvironment={eventEnvironment}
          eventRegistered={eventRegistered}
          checking={checking}
          error={err}
          getSetupTask={getSetupTask}
          onCheck={() => void checkStatus()}
          onOpenProject={() => navigate(successRoute, { replace: true })}
          onReviewMetrics={() => navigate('/registry', { replace: true })}
          onConnectMcp={() => navigate('/setup#agent-access', { replace: true })}
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
    <div className="mx-auto max-w-2xl space-y-5">
      <header>
        <div className="mb-2 flex items-center gap-3 text-xs text-muted-foreground">
          <span>Step {stage === 'mode' ? '1' : '2'} of 2</span>
          <span className="h-px flex-1 bg-border" aria-hidden="true" />
        </div>
        <h1 className="serif text-3xl font-normal">Connect your first project</h1>
        <p className="mt-2 max-w-xl text-sm text-muted-foreground">
          Tell us what you want to understand. Your agent will handle the setup.
        </p>
      </header>

      {stage === 'mode' ? (
        <section aria-labelledby="mode-title" className="rounded-lg border bg-card p-4 sm:p-5">
          <h2 ref={headingRef} tabIndex={-1} id="mode-title" className="text-lg font-semibold outline-none">What are you connecting?</h2>
          <div className="mt-4 grid gap-2 sm:grid-cols-3" role="radiogroup" aria-labelledby="mode-title">
            {MODES.map((item) => (
              <label
                key={item.id}
                className={cn(
                  'relative min-h-28 cursor-pointer rounded-md border p-3 outline-none transition-colors has-focus-visible:ring-2 has-focus-visible:ring-ring/50',
                  mode === item.id ? 'border-primary bg-primary/5' : 'bg-muted/10 hover:bg-accent/40',
                )}
              >
                <input
                  type="radio"
                  className="sr-only"
                  name="project-mode"
                  value={item.id}
                  checked={mode === item.id}
                  onChange={() => {
                    setMode(item.id);
                    if (item.id === 'product') setDomain('');
                    setGoalIds([]);
                    setCustomGoal('');
                  }}
                />
                <span className="flex items-start justify-between gap-2 text-sm font-medium">
                  {item.title}
                  {mode === item.id && <Check className="size-4 shrink-0 text-primary" aria-hidden="true" />}
                </span>
                <span className="mt-2 block text-xs leading-relaxed text-muted-foreground">{item.body}</span>
              </label>
            ))}
          </div>

          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="project-name">Project name</Label>
              <Input
                id="project-name"
                value={projectName}
                onChange={(event) => {
                  setProjectName(event.target.value);
                  setProjectSlug(slugify(event.target.value));
                }}
              />
            </div>
            {mode && mode !== 'product' && (
              <div className="space-y-1.5">
                <Label htmlFor="project-domain">Domain <span className="text-muted-foreground">(optional)</span></Label>
                <Input
                  id="project-domain"
                  inputMode="url"
                  placeholder="example.com"
                  value={domain}
                  aria-invalid={Boolean(domainError)}
                  aria-describedby={domainError ? 'project-domain-error' : undefined}
                  onChange={(event) => setDomain(event.target.value)}
                />
                {domainError && <p id="project-domain-error" role="alert" className="text-xs text-destructive">{domainError}</p>}
              </div>
            )}
          </div>

          <details className="mt-4 border-t pt-3">
            <summary className="cursor-pointer text-xs text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/50">Advanced</summary>
            <div className="mt-3 max-w-sm space-y-1.5">
              <Label htmlFor="project-slug">Project slug</Label>
              <Input id="project-slug" value={projectSlug} onChange={(event) => setProjectSlug(slugify(event.target.value))} />
            </div>
          </details>

          <div className="mt-5 flex justify-end">
            <Button
              onClick={() => setStage('goals')}
              disabled={!mode || !projectName.trim() || !projectSlug.trim() || Boolean(domainError)}
            >
              Continue
            </Button>
          </div>
        </section>
      ) : (
        <section aria-labelledby="goals-title" className="rounded-lg border bg-card p-4 sm:p-5">
          <h2 ref={headingRef} tabIndex={-1} id="goals-title" className="text-lg font-semibold outline-none">What do you want to understand?</h2>
          <p className="mt-1 text-sm text-muted-foreground">Choose up to three. Your agent will turn them into a tracking plan.</p>

          <div className="mt-4 space-y-2" role="group" aria-labelledby="goals-title">
            {[...availableGoals, { id: 'custom' as const, title: 'Something else' }].map((goal) => {
              const selected = goalIds.includes(goal.id);
              const disabled = !selected && goalIds.length >= 3;
              return (
                <label
                  key={goal.id}
                  className={cn(
                    'flex min-h-11 cursor-pointer items-center gap-3 rounded-md border px-3 py-2.5 outline-none transition-colors has-focus-visible:ring-2 has-focus-visible:ring-ring/50',
                    selected ? 'border-primary bg-primary/5' : 'bg-muted/10 hover:bg-accent/40',
                    disabled && 'cursor-not-allowed opacity-50',
                  )}
                >
                  <input
                    type="checkbox"
                    className="size-4 accent-primary"
                    checked={selected}
                    disabled={disabled}
                    onChange={() => toggleGoal(goal.id)}
                  />
                  <span className="flex-1 text-sm">{goal.title}</span>
                  {selected && <Check className="size-4 text-primary" aria-hidden="true" />}
                </label>
              );
            })}
          </div>

          {goalIds.length > 0 && (
            <p className="mt-2 text-xs text-muted-foreground" aria-live="polite">{goalIds.length} of 3 selected</p>
          )}

          {customSelected && (
            <div className="mt-4 space-y-1.5">
              <Label htmlFor="custom-goal">Describe the decision you want to make.</Label>
              <Textarea
                id="custom-goal"
                autoFocus
                value={customGoal}
                minLength={10}
                maxLength={500}
                aria-invalid={Boolean(customError)}
                aria-describedby="custom-goal-help"
                placeholder="Example: I need to know whether docs visitors become active users."
                onChange={(event) => setCustomGoal(event.target.value)}
              />
              <div id="custom-goal-help" className="flex items-start justify-between gap-3 text-xs">
                <span role={customError ? 'alert' : undefined} className={customError ? 'text-destructive' : 'text-muted-foreground'}>{customError ?? 'This stays in project intent and is never sent as product analytics.'}</span>
                <span className="shrink-0 text-muted-foreground">{customGoal.length}/500</span>
              </div>
            </div>
          )}

          {err && <div className="mt-4"><ErrorNote>{err}</ErrorNote></div>}

          <div className="mt-5 flex items-center justify-between gap-3">
            <Button variant="ghost" onClick={() => setStage('mode')}>
              <ArrowLeft className="size-4" aria-hidden="true" /> Back
            </Button>
            <Button onClick={() => void submit()} disabled={busy || !canCreate}>
              {busy && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
              {busy ? 'Creating…' : 'Create project'}
            </Button>
          </div>
        </section>
      )}
    </div>
  );
}
