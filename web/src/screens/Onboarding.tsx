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
import { DisclosureSummary } from '@/components/disclosure';
import { cn } from '@/lib/utils';
import {
  captureProductTelemetry,
  telemetryElapsedBucket,
  telemetryLengthBucket,
} from '../productTelemetry';

type ProjectMode = 'website' | 'product' | 'both';
type ProjectSurface = Exclude<ProjectMode, 'both'>;
type GoalId =
  | 'website_traffic' | 'website_pages' | 'website_conversion'
  | 'campaigns_referrals' | 'content_engagement' | 'activation'
  | 'feature_adoption' | 'retention' | 'release'
  | 'reliability_performance' | 'custom';

interface IntentOnboardingBody {
  workspace_name: string;
  project_name: string;
  project_slug: string;
  issue_personal_token: false;
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

const SURFACES: Array<{ id: ProjectSurface; title: string; body: string }> = [
  { id: 'website', title: 'A website', body: 'Traffic, pages, sources, and conversion.' },
  { id: 'product', title: 'A product', body: 'Activation, features, retention, and releases.' },
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

function projectModeForSurfaces(surfaces: ProjectSurface[]): ProjectMode | null {
  if (surfaces.length === 2) return 'both';
  return surfaces[0] ?? null;
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
  const onboardingStartedAt = useRef(Date.now());
  const completionTracked = useRef(false);
  const [workspace] = useState(account?.organization.name ?? 'My workspace');
  const [stage, setStage] = useState<'mode' | 'goals'>('mode');
  const [surfaces, setSurfaces] = useState<ProjectSurface[]>([]);
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
  const lastSeen = evidenceText(eventEvidence, 'received_at', 'last_seen', 'observed_at');
  const eventName = evidenceText(eventEvidence, 'event_name', 'event');
  const eventEnvironment = evidenceText(eventEvidence, 'environment', 'env') ?? 'prod';
  const eventRegistered = typeof eventEvidence.registered === 'boolean'
    ? eventEvidence.registered
    : eventEvidence.unregistered === true
      ? false
      : null;
  const mode = projectModeForSurfaces(surfaces);
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

  useEffect(() => {
    if (!result || !eventSeen || completionTracked.current) return;
    completionTracked.current = true;
    const elapsedBucket = telemetryElapsedBucket(Date.now() - onboardingStartedAt.current);
    const telemetryOptions = { distinctId: account?.user?.id };
    captureProductTelemetry('onboarding.first_event_received', { elapsed_bucket: elapsedBucket }, telemetryOptions);
    captureProductTelemetry('onboarding.completed', {
      mode: selectedMode,
      goal_ids: goalIds,
      elapsed_bucket: elapsedBucket,
    }, telemetryOptions);
  }, [account?.user?.id, eventSeen, goalIds, result, selectedMode]);

  const availableGoals = useMemo(() => mode ? GOALS[mode] : [], [mode]);

  const toggleGoal = (goalId: GoalId) => {
    const next = goalIds.includes(goalId)
      ? goalIds.filter((item) => item !== goalId)
      : goalIds.length === 3 ? goalIds : [...goalIds, goalId];
    if (next === goalIds) return;
    setGoalIds(next);
    captureProductTelemetry('onboarding.goals_selected', { goal_ids: next }, { distinctId: account?.user?.id });
  };

  const toggleSurface = (surface: ProjectSurface) => {
    const next = surfaces.includes(surface)
      ? surfaces.filter((item) => item !== surface)
      : [...surfaces, surface];
    setSurfaces(next);
    const nextMode = projectModeForSurfaces(next);
    if (nextMode) {
      captureProductTelemetry('onboarding.mode_selected', { mode: nextMode }, { distinctId: account?.user?.id });
    }
    if (!next.includes('website')) setDomain('');
    setGoalIds([]);
    setCustomGoal('');
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
        issue_personal_token: false,
        project_mode: mode,
        goal_ids: goalIds,
        custom_goal: customSelected ? customGoal.trim() : null,
        primary_goal_id: goalIds[0]!,
        website_domain: mode === 'product' ? null : normalizedDomain(domain),
      });
      if (customSelected) {
        captureProductTelemetry('onboarding.custom_goal_submitted', {
          length_bucket: telemetryLengthBucket(customGoal.trim().length),
        }, { distinctId: account?.user?.id });
      }
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
          <div className="mb-1 text-sm text-muted-foreground">{result.project.name} · prod</div>
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
          telemetryUserId={account?.user?.id}
          telemetryEnvironment="prod"
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
        <div className="mb-2 flex items-center gap-3 text-sm text-muted-foreground">
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
          <p className="mt-1 text-sm text-muted-foreground">Choose one or both.</p>
          <div className="mt-4 grid gap-2 sm:grid-cols-2" role="group" aria-labelledby="mode-title">
            {SURFACES.map((item) => {
              const selected = surfaces.includes(item.id);
              return (
                <label
                  key={item.id}
                  className={cn(
                    'relative min-h-28 cursor-pointer rounded-md border p-3 outline-none transition-colors has-focus-visible:ring-2 has-focus-visible:ring-ring',
                    selected ? 'border-brand-strong bg-primary/10 text-foreground' : 'bg-muted/10 hover:border-primary/60 hover:bg-primary/5',
                  )}
                >
                  <input
                    type="checkbox"
                    className="sr-only"
                    value={item.id}
                    checked={selected}
                    onChange={() => toggleSurface(item.id)}
                  />
                  <span className="flex items-start justify-between gap-2 text-sm font-medium">
                    {item.title}
                    <span className={cn(
                      'flex size-5 shrink-0 items-center justify-center rounded-sm border',
                      selected ? 'border-primary bg-primary text-primary-foreground' : 'border-input bg-card',
                    )} aria-hidden="true">
                      {selected && <Check className="size-3.5" />}
                    </span>
                  </span>
                  <span className="mt-2 block text-sm leading-relaxed text-muted-foreground">{item.body}</span>
                </label>
              );
            })}
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
                {domainError && <p id="project-domain-error" role="alert" className="text-sm text-destructive">{domainError}</p>}
              </div>
            )}
          </div>

          <details className="group/disclosure mt-4 border-t pt-3">
            <DisclosureSummary className="inline-flex cursor-pointer items-center text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">Advanced</DisclosureSummary>
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
                    'flex min-h-11 cursor-pointer items-center gap-3 rounded-md border px-3 py-2.5 outline-none transition-colors has-focus-visible:ring-2 has-focus-visible:ring-ring',
                    selected ? 'border-brand-strong bg-primary/10 text-foreground' : 'bg-muted/10 hover:border-primary/60 hover:bg-primary/5',
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
                  {selected && <Check className="size-4 text-foreground" aria-hidden="true" />}
                </label>
              );
            })}
          </div>

          {goalIds.length > 0 && (
            <p className="mt-2 text-sm text-muted-foreground" aria-live="polite">{goalIds.length} of 3 selected</p>
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
              <div id="custom-goal-help" className="flex items-start justify-between gap-3 text-sm">
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
