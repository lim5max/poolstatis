import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2 } from '@/components/icons';
import { useStore, useAsync } from '../store';
import { MCP_CLIENTS, MCP_RUNNER, mcpClientById, mcpServerConfig, type McpClientId } from '../mcpClients';
import {
  CopyButton,
  ConnectionProgress,
  ProductConnectionGuide,
  type AgentId,
  type SetupTaskResponse,
} from '../components/ProductConnectionGuide';
import { Panel, Loading, DangerConfirm, ErrorNote, PageHeading } from '../components/ui';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import {
  claimProductTelemetryOnce,
  captureProductTelemetry,
  telemetryEnvironment,
  telemetryLatencyBucket,
} from '../productTelemetry';
import { buildInstallationPack } from '../onboardingGoals';
import type { DecisionLoopOnboardingStatus, OnboardingGateKey, ProjectGoalId } from '../api/types';
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { DisclosureSummary } from '@/components/disclosure';

const SKILLS_CLI = 'skills@1.5.22';
const SKILLS_SOURCE = 'https://github.com/lim5max/poolstatis/archive/45af081344dc910933a0d274892e53cf417fa5fb.tar.gz';
const SKILLS = 'poolstatis-instrument poolstatis-analyze poolstatis-maintain';

const TOOLS = [
  ['Context', ['list_projects', 'get_project_schema', 'get_onboarding_status']],
  ['Measurement trust', ['register_metric', 'register_property', 'validate_measurement_contracts', 'list_data_quality_issues']],
  ['Decision loop', ['register_release', 'evaluate_release', 'list_decisions', 'explain_outcome']],
  ['Queries', ['query_trend', 'query_funnel', 'query_retention', 'query_lifecycle', 'query_stickiness']],
  ['Delivery', ['configure_webhook', 'verify_webhook']],
] as const;

interface SetupIntent {
  project_mode: 'website' | 'product' | 'both';
  goal_ids: ProjectGoalId[];
  custom_goal: string | null;
}

interface SetupClient {
  projectIntent(slug: string): Promise<{ intent: SetupIntent | null }>;
  setupTask(slug: string, body: {
    agent_id: AgentId;
    prefer_llm?: boolean;
    kind?: 'initial' | 'fix';
    env?: string;
  }): Promise<SetupTaskResponse>;
  setupTaskFeedback(slug: string, body: { outcome: 'blocked'; blocker: string }): Promise<{ recorded: true }>;
}

export function Setup() {
  const { account, client, baseUrl, token, tokenKind, projects, project, env } = useStore();
  const navigate = useNavigate();
  const [freshIngestKey, setFreshIngestKey] = useState<string | null>(null);
  const [creatingKey, setCreatingKey] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [connectionOpen, setConnectionOpen] = useState<boolean | null>(null);
  const [connectionStep, setConnectionStep] = useState<1 | 2 | 3>(1);
  const [mcpOpen, setMcpOpen] = useState(() => window.location.hash === '#agent-access');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const uiScope = `${project ?? ''}\u0000${env}`;
  const telemetryScope = `${project ?? 'none'}:${env}`;
  const currentScope = useRef(uiScope);
  currentScope.current = uiScope;
  const publicUrl =
    (import.meta.env.VITE_POOLSTATIS_PUBLIC_URL as string | undefined) ||
    (import.meta.env.VITE_POOLSTATIS_API_URL as string | undefined) ||
    'https://api.poolstatis.xyz';
  const serverUrl = (baseUrl || publicUrl).replace(/\/$/, '');
  const selectedProject = projects.find((item) => item.slug === project);
  const projectName = selectedProject?.name ?? project ?? 'Product';
  const setupClient = client as unknown as SetupClient | null;

  const proof = useAsync(
    async () => {
      const startedAt = performance.now();
      try {
        return {
          scope: uiScope,
          value: project ? await client!.onboardingStatus(project, env) : null,
          error: null as string | null,
          readBackAt: new Date().toISOString(),
          latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
        };
      } catch (caught) {
        return {
          scope: uiScope,
          value: null,
          error: setupStatusMessage(caught),
          readBackAt: new Date().toISOString(),
          latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
        };
      }
    },
    [project, env],
  );
  const intent = useAsync(
    async () => ({
      scope: uiScope,
      value: project && setupClient && typeof setupClient.projectIntent === 'function'
        ? await setupClient.projectIntent(project)
        : { intent: null },
    }),
    [project, env],
  );
  const standard = useAsync(
    () => advancedOpen ? client!.standard() : Promise.resolve(null),
    [advancedOpen],
  );

  const proofData = proof.data?.scope === uiScope ? proof.data.value : null;
  const proofError = proof.data?.scope === uiScope ? proof.data.error : null;
  const intentData = intent.data?.scope === uiScope ? intent.data.value : null;
  const sourceGate = proofData?.gates.find((gate) => gate.key === 'data_source_connected');
  const eventGate = proofData?.gates.find((gate) => gate.key === 'first_event_observed');
  const agentGate = proofData?.gates.find((gate) => gate.key === 'agent_connected');
  const eventSeen = eventGate?.complete ?? false;
  const lastSeen = typeof eventGate?.evidence.received_at === 'string'
    ? eventGate.evidence.received_at
    : typeof eventGate?.evidence.last_seen === 'string'
      ? eventGate.evidence.last_seen
      : null;
  const eventName = typeof eventGate?.evidence.event_name === 'string'
    ? eventGate.evidence.event_name
    : typeof eventGate?.evidence.event === 'string'
      ? eventGate.evidence.event
      : null;
  const eventEnvironment = typeof eventGate?.evidence.environment === 'string'
    ? eventGate.evidence.environment
    : typeof eventGate?.evidence.env === 'string'
      ? eventGate.evidence.env
      : env;
  const eventRegistered = typeof eventGate?.evidence.registered === 'boolean'
    ? eventGate.evidence.registered
    : eventGate?.evidence.unregistered === true
      ? false
      : null;
  const preferLlm = Boolean(intentData?.intent?.custom_goal);
  const serverBlocker = proofData?.next_blocker ?? null;
  const blockerCode = serverBlocker ? normalizeBlockerKey(serverBlocker.key) : null;
  const blockerEvidence = localEvidenceFingerprint(serverBlocker?.evidence ?? {});

  useLayoutEffect(() => {
    setFreshIngestKey(null);
    setCreatingKey(false);
    setKeyError(null);
    setConnectionOpen(null);
    setConnectionStep(1);
    setMcpOpen(window.location.hash === '#agent-access');
    setAdvancedOpen(false);
  }, [uiScope]);

  useEffect(() => {
    if (!project || eventSeen) return;
    let timer: number | null = null;
    const stop = () => {
      if (timer !== null) window.clearInterval(timer);
      timer = null;
    };
    const start = () => {
      if (document.hidden || timer !== null) return;
      timer = window.setInterval(() => proof.reload(), 5000);
    };
    const onVisibility = () => {
      if (document.hidden) {
        stop();
        return;
      }
      proof.reload();
      start();
    };
    start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
    // The reload callback is intentionally read from the latest render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventSeen, project]);

  useEffect(() => {
    if (!blockerCode || !claimProductTelemetryOnce(`setup:blocker:${telemetryScope}:${blockerCode}:${blockerEvidence}`)) return;
    captureProductTelemetry('onboarding.blocked', { blocker: blockerCode }, { distinctId: account?.user?.id });
  }, [account?.user?.id, blockerCode, blockerEvidence, telemetryScope]);

  useEffect(() => {
    if (!eventSeen || !agentGate?.complete || !claimProductTelemetryOnce(`setup:mcp_connected:${telemetryScope}`, 'local')) return;
    captureProductTelemetry('mcp.connected', {}, { distinctId: account?.user?.id });
  }, [account?.user?.id, agentGate?.complete, eventSeen, telemetryScope]);

  const createIngestKey = async () => {
    if (!client || !project) return;
    const requestedScope = uiScope;
    setCreatingKey(true);
    setKeyError(null);
    try {
      const created = await client.issueKey(project, { kind: 'ingest', env, label: 'Setup guide' });
      if (currentScope.current !== requestedScope) return;
      setFreshIngestKey(created.token);
      proof.reload();
    } catch (error) {
      if (currentScope.current !== requestedScope) return;
      setKeyError((error as Error).message);
    } finally {
      if (currentScope.current === requestedScope) setCreatingKey(false);
    }
  };

  const getSetupTask = useCallback(async (agentId: AgentId) => {
    if (!setupClient || !project || typeof setupClient.setupTask !== 'function') {
      throw new Error('Setup task generation is unavailable on this server.');
    }
    return setupClient.setupTask(project, { agent_id: agentId, prefer_llm: preferLlm, env });
  }, [env, preferLlm, project, setupClient]);

  if (!project) {
    return <Panel title="Setup"><p className="text-sm text-muted-foreground">Select a project first.</p></Panel>;
  }

  const sourceReady = sourceGate?.complete ?? false;
  const connectionVisible = connectionOpen ?? false;
  const currentConnectionStep: 1 | 2 | 3 = eventSeen ? 3 : connectionStep;
  const nextConnectionAction = currentConnectionStep === 1
    ? 'Create and save a product key'
    : currentConnectionStep === 2
      ? 'Copy one setup task to your agent'
      : 'Send one real event';
  const projectMode = intentData?.intent?.project_mode;
  const installationPack = buildInstallationPack(intentData?.intent?.goal_ids ?? []);
  const nextStep = resolveSetupNextStep({ status: proofData, loading: proof.loading, error: proofError, mode: projectMode ?? null });

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <PageHeading
        title="Setup"
        lead="Complete the next verified step."
        help="Poolstatis checks each gate on the server, from connection to the first protected decision. Copying config or a task never marks a gate complete."
        meta={<>{projectName} · {env}</>}
      />

      <section className="rounded-panel border bg-card p-4 sm:p-5" aria-labelledby="setup-next-step-title" aria-live="polite">
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
          <div className="min-w-0">
            <div className="text-sm font-medium text-muted-foreground">Next verified step</div>
            <h2 id="setup-next-step-title" className="mt-1 text-xl font-semibold">{nextStep.title}</h2>
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">{nextStep.reason}</p>
          </div>
          <SetupPrimaryAction
            step={nextStep}
            project={project}
            env={env}
            client={setupClient}
            telemetryUserId={account?.user?.id}
            onConnection={() => setConnectionOpen(true)}
            connectionOpen={connectionVisible}
            onAgent={() => setMcpOpen(true)}
            onRetry={proof.reload}
            onNavigate={navigate}
          />
        </div>
        <SetupDecisionProgress status={proofData} />
        {proof.data?.scope === uiScope && (
          <p className="mt-3 text-xs text-muted-foreground">
            Server read-back <time dateTime={proof.data.readBackAt}>{formatTimestamp(proof.data.readBackAt)}</time> · {proof.data.latencyMs} ms · {env}
          </p>
        )}
      </section>

      <div className="space-y-3 border-y py-4">
        {!eventSeen && <ConnectionProgress current={currentConnectionStep} complete={false} />}
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
          <div className="font-medium">
            {eventSeen
              ? <>Connected <span className="font-normal text-muted-foreground">· {lastSeen ? `last event ${relativeTime(lastSeen)} · ` : ''}{env}</span></>
              : `Next: ${nextConnectionAction}`}
          </div>
          {eventSeen && <Button size="sm" variant="outline" onClick={() => setConnectionOpen(true)}>View connection</Button>}
        </div>
      </div>

      {proofData && <SetupEvidenceLedger status={proofData} />}

      {proofData?.final_result && <VerifiedFirstOutcome result={proofData.final_result} />}

      {connectionVisible && (
        <ProductConnectionGuide
          key={`${uiScope}:connection`}
          ingestKey={freshIngestKey}
          keyReady={sourceReady}
          serverUrl={serverUrl}
          projectName={projectName}
          projectSlug={project}
          projectMode={projectMode ?? 'product'}
          installationPack={installationPack}
          eventSeen={eventSeen}
          lastSeen={lastSeen}
          eventName={eventName}
          eventEnvironment={eventEnvironment}
          eventRegistered={eventRegistered}
          checking={proof.loading}
          creatingKey={creatingKey}
          error={keyError ?? proofError}
          onCreateKey={() => void createIngestKey()}
          getSetupTask={getSetupTask}
          onCheck={proof.reload}
          onOpenProject={() => navigate(projectMode === 'website' ? '/analyze/web' : projectMode === 'product' ? '/analyze/product' : '/')}
          onReviewMetrics={() => navigate('/registry')}
          telemetryUserId={account?.user?.id}
          telemetryEnvironment={telemetryEnvironment(env)}
          showProgress={false}
          onStepChange={setConnectionStep}
        />
      )}

      <section className="overflow-hidden rounded-lg border bg-card" aria-label="Setup status">
        <SetupRow
          title="Product connection"
          status={eventSeen ? 'Connected' : sourceReady ? 'Waiting for event' : 'Needs setup'}
          description={eventSeen ? `Last server-verified event${lastSeen ? ` ${relativeTime(lastSeen)}` : ''}.` : 'Product key, SDK, and first server-verified event.'}
          action={connectionVisible ? 'Hide' : eventSeen ? 'View' : 'Show'}
          onAction={() => setConnectionOpen(!connectionVisible)}
        />
        <SetupRow
          title="Tracking plan"
          status={intent.loading ? 'Checking' : intentData?.intent ? `${intentData.intent.goal_ids.length} goals` : 'Not set'}
          description={intentData?.intent ? 'Selected outcomes shape the setup task and first answers.' : 'Existing projects keep working without choosing a mode.'}
          action="Review"
          onAction={() => navigate('/measurement')}
        />
        <SetupRow
          title="Agent access"
          status={agentGate?.complete ? 'Connected' : 'Optional'}
          description="Let your agent read analytics and manage Poolstatis with MCP."
          action={mcpOpen ? 'Hide' : agentGate?.complete ? 'View' : 'Connect'}
          onAction={() => {
            if (!mcpOpen && eventSeen) {
              captureProductTelemetry('mcp.connect_started', {}, { distinctId: account?.user?.id });
            }
            setMcpOpen((value) => !value);
          }}
        />
        <SetupRow
          title="Destinations & advanced"
          status="Optional"
          description="Webhooks, raw examples, key types, standards, and project controls."
          action={advancedOpen ? 'Hide' : 'Open'}
          onAction={() => setAdvancedOpen((value) => !value)}
          last
        />
      </section>

      {mcpOpen && (
        <OptionalMcp
          key={`${uiScope}:mcp`}
          serverUrl={serverUrl}
          storedToken={tokenKind === 'personal' || tokenKind === 'secret' ? token : null}
          canIssuePersonalToken={tokenKind === 'user'}
          connected={agentGate?.complete ?? false}
        />
      )}

      {advancedOpen && (
        <section key={`${uiScope}:advanced`} className="space-y-4 rounded-lg border bg-card p-4" aria-label="Advanced setup and administration">
          <KeyMap />
          <HttpExample serverUrl={serverUrl} />
          <WebhookSetup project={project} />
          <Panel title="MCP tool groups">
            <div className="grid gap-3 sm:grid-cols-2">
              {TOOLS.map(([group, tools]) => (
                <div key={group}>
                  <div className="mb-2 text-xs font-medium text-muted-foreground">{group}</div>
                  <div className="flex flex-wrap gap-1.5">
                    {tools.map((tool) => <Badge key={tool} variant="outline" className="font-mono text-xs font-normal">{tool}</Badge>)}
                  </div>
                </div>
              ))}
            </div>
          </Panel>
          <Panel title="Instrumentation standard">
            {standard.loading
              ? <Loading what="loading the standard…" />
              : <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-md border bg-background p-4 text-xs leading-relaxed">{standard.error ? `Could not load standard: ${standard.error}` : standard.data}</pre>}
          </Panel>
          <DangerZone slug={project} env={env} />
        </section>
      )}
    </div>
  );
}

type SetupNextStep = {
  kind: 'loading' | 'retry' | 'connection' | 'route' | 'fix' | 'agent';
  title: string;
  reason: string;
  label: string;
  route?: string;
  blocker?: OnboardingGateKey;
};

export function resolveSetupNextStep(input: {
  status: DecisionLoopOnboardingStatus | null;
  loading: boolean;
  error: string | null;
  mode: SetupIntent['project_mode'] | null;
}): SetupNextStep {
  if (!input.status && !input.error) return {
    kind: 'loading', title: 'Checking server proof', reason: 'Reading the current setup gates for this project and environment.', label: 'Checking…',
  };
  if (input.error) return {
    kind: 'retry', title: 'Setup status is unavailable', reason: input.error, label: 'Retry verification',
  };
  const blocker = input.status?.next_blocker;
  if (input.status?.complete) {
    const finalArtifact = input.status.gates.find((gate) => gate.key === 'first_decision_saved');
    const hasProtectedDecision = finalArtifact?.evidence.artifact_kind === 'protected_decision'
      || typeof finalArtifact?.evidence.decision_id === 'string';
    return {
      kind: 'route',
      title: hasProtectedDecision ? 'Decision loop is ready' : 'Analysis loop is ready',
      reason: hasProtectedDecision
        ? 'Connection, definitions, the first answer, and the first protected decision have server proof.'
        : 'Connection, definitions, the first answer, and a saved evidence-backed insight have server proof. A protected human decision remains a separate Ship lifecycle step.',
      label: 'Open Home', route: '/',
    };
  }
  if (!blocker) return {
    kind: 'retry', title: 'Next setup step is unavailable', reason: 'The server reports setup is incomplete but did not identify a next blocker.', label: 'Retry verification',
  };
  const reason = blocker.blocker ?? blocker.next_action ?? 'Complete the next server-verified setup gate.';
  switch (blocker.key) {
    case 'workspace_created':
    case 'data_source_connected':
      return { kind: 'connection', title: 'Connect the product', reason, label: 'Open connection', blocker: blocker.key };
    case 'first_event_observed':
      return { kind: 'connection', title: 'Verify the first event', reason, label: 'Send first event', blocker: blocker.key };
    case 'metrics_activated':
      return { kind: 'route', title: 'Review the registry', reason, label: 'Review registry', route: '/registry', blocker: blocker.key };
    case 'data_quality_accepted':
      return { kind: 'route', title: 'Verify the key metric', reason, label: 'Review key metric', route: '/measurement', blocker: blocker.key };
    case 'first_query_produced':
      return {
        kind: 'fix',
        title: input.mode === 'website' ? 'Produce the first web answer' : 'Run the first query for a funnel or outcome',
        reason,
        label: 'Copy answer task',
        route: input.mode === 'website' ? '/analyze/web' : '/analyze/funnels',
        blocker: blocker.key,
      };
    case 'first_decision_saved':
      return { kind: 'fix', title: 'Save the first evidence-backed decision', reason, label: 'Copy decision task', route: '/decisions', blocker: blocker.key };
    case 'agent_connected':
      return { kind: 'agent', title: 'Verify agent access', reason, label: 'Connect agent', blocker: blocker.key };
  }
}

const GATE_LABELS: Record<OnboardingGateKey, string> = {
  workspace_created: 'Workspace created',
  agent_connected: 'Agent connected',
  data_source_connected: 'Data source connected',
  first_event_observed: 'First event observed',
  metrics_activated: 'Metrics activated',
  data_quality_accepted: 'Data quality accepted',
  first_query_produced: 'First query produced',
  first_decision_saved: 'First decision saved',
};

function setupGateLabel(gate: DecisionLoopOnboardingStatus['gates'][number]): string {
  if (gate.key !== 'first_decision_saved') return GATE_LABELS[gate.key];
  if (gate.evidence.artifact_kind === 'protected_decision' || typeof gate.evidence.decision_id === 'string') {
    return 'First protected decision saved';
  }
  if (gate.evidence.artifact_kind === 'saved_insight' || typeof gate.evidence.insight_id === 'string') {
    return 'First evidence-backed insight saved';
  }
  return GATE_LABELS[gate.key];
}

function SetupEvidenceLedger({ status }: { status: DecisionLoopOnboardingStatus }) {
  return (
    <details className="overflow-hidden rounded-panel border bg-card">
      <DisclosureSummary className="flex min-h-14 cursor-pointer items-center justify-between gap-3 px-4 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:px-5">
        <span className="font-medium">Server evidence</span>
        <Badge variant="outline">{status.gates.filter((gate) => gate.complete).length}/{status.gates.length} verified</Badge>
      </DisclosureSummary>
      <ol className="divide-y border-t" aria-label="Setup gate evidence">
        {status.gates.map((gate) => {
          const timestamp = latestEvidenceTimestamp(gate.evidence);
          const entries = Object.entries(gate.evidence);
          return (
            <li key={gate.key} className="grid min-w-0 gap-3 px-4 py-3 sm:grid-cols-[minmax(10rem,0.7fr)_minmax(0,1.3fr)] sm:px-5">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{setupGateLabel(gate)}</span>
                  <Badge variant={gate.complete ? 'default' : gate.required ? 'outline' : 'secondary'}>{gate.complete ? 'Verified' : gate.required ? 'Pending' : 'Optional'}</Badge>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {timestamp ? <>Evidence as of <time dateTime={timestamp}>{formatTimestamp(timestamp)}</time></> : 'Evidence freshness unavailable · no timestamp returned'}
                </p>
              </div>
              <div className="min-w-0">
                {entries.length > 0 ? (
                  <dl className="grid min-w-0 gap-x-3 gap-y-1 text-xs sm:grid-cols-[minmax(8rem,auto)_minmax(0,1fr)]">
                    {entries.map(([key, value]) => (
                      <div key={key} className="contents">
                        <dt className="font-mono text-muted-foreground">{key}</dt>
                        <dd className="break-words font-mono">{safeEvidenceValue(value)}</dd>
                      </div>
                    ))}
                  </dl>
                ) : <p className="text-xs text-muted-foreground">No server evidence yet.</p>}
                {!gate.complete && gate.blocker && <p className="mt-2 text-xs text-muted-foreground">Blocker · {gate.blocker}</p>}
              </div>
            </li>
          );
        })}
      </ol>
    </details>
  );
}

function VerifiedFirstOutcome({ result }: { result: NonNullable<DecisionLoopOnboardingStatus['final_result']> }) {
  return (
    <section className="rounded-panel border bg-card p-4 sm:p-5" role="region" aria-label="Verified first outcome">
      <div className="text-xs font-medium text-muted-foreground">Verified funnel or outcome read-back</div>
      <h2 className="mt-1 text-base font-medium"><code>{result.metric_key}</code></h2>
      <p className="mt-1 text-sm text-muted-foreground">{result.metric_purpose}</p>
      <dl className="mt-4 grid gap-3 text-xs sm:grid-cols-3">
        <div><dt className="text-muted-foreground">Source</dt><dd className="mt-1 font-mono">{result.source}</dd></div>
        <div className="sm:col-span-2"><dt className="text-muted-foreground">Query window</dt><dd className="mt-1 break-words font-mono">{result.query_window.from} → {result.query_window.to}</dd></div>
      </dl>
      <p className="mt-4 border-t pt-3 text-sm"><span className="text-muted-foreground">Next action · </span>{result.next_action}</p>
    </section>
  );
}

function SetupPrimaryAction({ step, project, env, client, telemetryUserId, connectionOpen, onConnection, onAgent, onRetry, onNavigate }: {
  step: SetupNextStep;
  project: string;
  env: string;
  client: SetupClient | null;
  telemetryUserId?: string | null;
  connectionOpen: boolean;
  onConnection: () => void;
  onAgent: () => void;
  onRetry: () => void;
  onNavigate: ReturnType<typeof useNavigate>;
}) {
  if (step.kind === 'loading') return <Button className="h-11" disabled><Loader2 className="size-4 animate-spin" />{step.label}</Button>;
  if (step.kind === 'retry') return <Button className="h-11" onClick={onRetry}>{step.label}</Button>;
  if (step.kind === 'connection') return connectionOpen ? null : <Button className="h-11" onClick={onConnection}>{step.label}</Button>;
  if (step.kind === 'agent') return <Button className="h-11" onClick={onAgent}>{step.label}</Button>;
  if (step.kind === 'fix' && step.blocker && client && typeof client.setupTaskFeedback === 'function') {
    return (
      <FixTaskAction
        projectSlug={project}
        env={env}
        client={client}
        telemetryUserId={telemetryUserId}
        label={step.label}
      />
    );
  }
  return <Button className="h-11" onClick={() => onNavigate(step.route ?? '/')}>{step.label}</Button>;
}

function SetupDecisionProgress({ status }: { status: DecisionLoopOnboardingStatus | null }) {
  const phases = [
    { label: 'Connect', keys: ['data_source_connected', 'first_event_observed'] as OnboardingGateKey[] },
    { label: 'Define', keys: ['metrics_activated', 'data_quality_accepted'] as OnboardingGateKey[] },
    { label: 'Answer', keys: ['first_query_produced'] as OnboardingGateKey[] },
    { label: 'Decide', keys: ['first_decision_saved'] as OnboardingGateKey[] },
  ];
  const completed = new Set(status?.gates.filter((gate) => gate.complete).map((gate) => gate.key) ?? []);
  const blockerPhase: Partial<Record<OnboardingGateKey, number>> = {
    workspace_created: 0,
    agent_connected: 0,
    data_source_connected: 0,
    first_event_observed: 0,
    metrics_activated: 1,
    data_quality_accepted: 1,
    first_query_produced: 2,
    first_decision_saved: 3,
  };
  const verifiedCurrent = status?.next_blocker ? blockerPhase[status.next_blocker.key] : undefined;
  const current = verifiedCurrent ?? phases.findIndex((phase) => phase.keys.some((key) => !completed.has(key)));
  return (
    <ol className="mt-5 grid gap-2 border-t pt-4 sm:grid-cols-4" aria-label="Setup decision path">
      {phases.map((phase, index) => {
        const complete = phase.keys.every((key) => completed.has(key));
        const active = current === index;
        return (
          <li key={phase.label} className={`rounded-control border px-3 py-2 text-sm ${active ? 'border-primary/50 bg-primary/10' : complete ? 'bg-muted/30' : 'border-dashed text-muted-foreground'}`}>
            <span className="font-mono text-muted-foreground">{index + 1}</span> <span className="font-medium">{phase.label}</span>
            <span className="mt-1 block text-muted-foreground">{complete ? 'Verified' : active ? 'Next' : 'Pending'}</span>
          </li>
        );
      })}
    </ol>
  );
}

function SetupRow({ title, status, description, action, onAction, last = false }: {
  title: string;
  status: string;
  description: string;
  action: string;
  onAction: () => void;
  last?: boolean;
}) {
  return (
    <div className={cn('grid gap-2 px-4 py-3.5 sm:grid-cols-[10rem_8rem_1fr_auto] sm:items-center', !last && 'border-b')}>
      <div className="text-sm font-medium">{title}</div>
      <div><Badge variant={status === 'Connected' ? 'default' : 'outline'}>{status}</Badge></div>
      <p className="text-xs text-muted-foreground">{description}</p>
      <Button size="sm" variant="ghost" onClick={onAction}>{action}</Button>
    </div>
  );
}

function FixTaskAction({ projectSlug, env, client, telemetryUserId, label = 'Copy fix task' }: {
  projectSlug: string;
  env: string;
  client: SetupClient;
  telemetryUserId?: string | null;
  label?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [fallbackTask, setFallbackTask] = useState<{ task: string; blocker: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const copyTracked = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const recordFeedback = async (blocker: string) => {
    await client.setupTaskFeedback(projectSlug, {
      outcome: 'blocked',
      blocker,
    });
  };

  const copyFixTask = async () => {
    setBusy(true);
    setCopied(false);
    setFallbackTask(null);
    setError(null);
    try {
      const startedAt = Date.now();
      const response = await client.setupTask(projectSlug, {
        agent_id: 'codex',
        prefer_llm: false,
        kind: 'fix',
        env,
      });
      if (!mounted.current) return;
      const task = response.task.trim();
      const responseBlocker = typeof response.blocker === 'string'
        ? normalizeBlockerKey(response.blocker)
        : null;
      if (!task) throw new Error('The server returned an empty setup task.');
      if (!responseBlocker) throw new Error('The server returned a fix task without a verified blocker.');
      if (containsCredentialValue(task)) {
        throw new Error('Task generation was blocked because it contained credential-like text.');
      }
      captureProductTelemetry('onboarding.task_generated', {
        source: response.source,
        latency_bucket: telemetryLatencyBucket(Date.now() - startedAt),
      }, { distinctId: telemetryUserId });
      try {
        await navigator.clipboard.writeText(task);
      } catch {
        if (!mounted.current) return;
        setFallbackTask({ task, blocker: responseBlocker });
        return;
      }
      if (!mounted.current) return;
      if (!copyTracked.current) {
        copyTracked.current = true;
        captureProductTelemetry('onboarding.task_copied', {
          agent_id: 'codex',
          method: 'clipboard',
        }, { distinctId: telemetryUserId });
      }
      if (!mounted.current) return;
      await recordFeedback(responseBlocker);
      if (!mounted.current) return;
      setCopied(true);
    } catch (caught) {
      if (mounted.current) setError(caught instanceof Error ? caught.message : 'Could not prepare the fix task.');
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const confirmManualCopy = async () => {
    setBusy(true);
    setError(null);
    try {
      if (!fallbackTask) return;
      if (!copyTracked.current) {
        copyTracked.current = true;
        captureProductTelemetry('onboarding.task_copied', {
          agent_id: 'codex',
          method: 'manual',
        }, { distinctId: telemetryUserId });
      }
      if (!mounted.current) return;
      await recordFeedback(fallbackTask.blocker);
      if (!mounted.current) return;
      setFallbackTask(null);
      setCopied(true);
    } catch (caught) {
      if (mounted.current) setError(caught instanceof Error ? caught.message : 'Could not record the copied task.');
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  return (
    <div className="flex max-w-xl flex-col items-start gap-2">
      <Button className="h-11" onClick={() => void copyFixTask()} disabled={busy || Boolean(fallbackTask)}>
        {busy && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
        {busy ? 'Preparing task…' : copied ? 'Task copied' : label}
      </Button>
      {fallbackTask && (
        <div className="space-y-2">
          <p role="alert" className="text-xs text-destructive">Copy was blocked by the browser. Select the task below and copy it manually.</p>
          <pre tabIndex={0} className="max-h-72 max-w-full overflow-auto whitespace-pre-wrap rounded-md border bg-background p-3 text-xs text-foreground">{fallbackTask.task}</pre>
          <Button size="sm" variant="outline" onClick={() => void confirmManualCopy()} disabled={busy}>I copied it</Button>
        </div>
      )}
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

function containsCredentialValue(value: string): boolean {
  return /\b(?:pk|sk|pt)_[a-z0-9][a-z0-9_-]{3,}/i.test(value);
}

function setupStatusMessage(caught: unknown): string {
  const message = caught instanceof Error ? caught.message : String(caught);
  if (/oauth2|content-type|session|token/i.test(message)) {
    return 'Your session could not be refreshed. Sign in again, then retry.';
  }
  return 'Poolstatis could not verify setup right now. Retry the check.';
}

function normalizeBlockerKey(value: string): string | null {
  const normalized = value.trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 100)
    .replace(/_+$/g, '');
  return /^[a-z][a-z0-9_]*$/.test(normalized) ? normalized : null;
}

function localEvidenceFingerprint(value: unknown): string {
  const serialized = typeof value === 'string'
    ? value
    : value && typeof value === 'object' && !Array.isArray(value)
      ? JSON.stringify(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)))
      : String(value);
  let hash = 2166136261;
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= serialized.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function latestEvidenceTimestamp(evidence: Record<string, unknown>): string | null {
  const timestamps = Object.entries(evidence)
    .filter(([key, value]) => typeof value === 'string' && /(?:_at|_seen|timestamp)$/.test(key))
    .map(([, value]) => value as string)
    .filter((value) => Number.isFinite(Date.parse(value)))
    .sort((left, right) => Date.parse(right) - Date.parse(left));
  return timestamps[0] ?? null;
}

function safeEvidenceValue(value: unknown): string {
  const formatted = typeof value === 'string' ? value : JSON.stringify(value);
  if (!formatted) return String(value);
  return containsCredentialValue(formatted) ? '[credential redacted]' : formatted;
}

function formatTimestamp(value: string): string {
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) return value;
  return timestamp.toLocaleString();
}

function OptionalMcp({ serverUrl, storedToken, canIssuePersonalToken, connected }: {
  serverUrl: string;
  storedToken: string | null;
  canIssuePersonalToken: boolean;
  connected: boolean;
}) {
  const { client } = useStore();
  const [clientId, setClientId] = useState<McpClientId>('codex');
  const [freshToken, setFreshToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedClient = mcpClientById(clientId);
  const mcpToken = freshToken ?? storedToken;
  const config = mcpServerConfig(
    MCP_RUNNER.command,
    MCP_RUNNER.args,
    serverUrl,
    mcpToken ?? '<create-agent-token-first>',
  );
  const skillTarget = clientId === 'codex' ? 'codex' : clientId === 'claude-code' ? 'claude-code' : "'*'";
  const skillsCommand = `pnpm dlx ${SKILLS_CLI} add ${SKILLS_SOURCE} --skill ${SKILLS} --agent ${skillTarget} -y`;

  const issueToken = async () => {
    if (!client) return;
    setBusy(true);
    setError(null);
    try {
      const created = await client.issuePersonalToken({ label: `${selectedClient.name} MCP` });
      setFreshToken(created.token);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-lg border bg-card p-4" id="agent-access" aria-labelledby="agent-access-title">
      <div className="flex items-center gap-2">
        <h2 id="agent-access-title" className="text-sm font-medium">Let your agent answer questions</h2>
        <Badge variant={connected ? 'default' : 'outline'}>{connected ? 'Connected' : 'Optional'}</Badge>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">Connect MCP so your agent can read analytics and manage Poolstatis.</p>
      <div className="mt-4 space-y-4 border-t pt-4">
          <div className="max-w-sm">
            <div className="mb-1.5 text-xs font-medium text-muted-foreground">Where does your agent run?</div>
            <Select value={clientId} onValueChange={(value) => setClientId(value as McpClientId)}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                {(['Popular MCP hosts', 'IDE agents', 'Advanced/custom'] as const).map((group, index) => (
                  <SelectGroup key={group}>
                    {index > 0 && <SelectSeparator />}
                    <SelectLabel>{group}</SelectLabel>
                    {MCP_CLIENTS.filter((profile) => profile.group === group).map((profile) => (
                      <SelectItem key={profile.id} value={profile.id}>{profile.name}</SelectItem>
                    ))}
                  </SelectGroup>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <div className="mb-2 text-xs font-medium text-muted-foreground">1. Install the Poolstatis skills</div>
            <CodeBlock code={skillsCommand} copyLabel="Copy skills command" />
            <p className="mt-1.5 text-xs text-muted-foreground">This installs instrument, analyze, and maintain workflows for {selectedClient.name}.</p>
          </div>

          <div>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <div className="text-xs font-medium text-muted-foreground">2. Add the MCP server</div>
              {!mcpToken && canIssuePersonalToken && (
                <Button size="sm" onClick={() => void issueToken()} disabled={busy}>
                  {busy && <Loader2 className="size-3.5 animate-spin" />}
                  {busy ? 'Creating…' : 'Create agent token'}
                </Button>
              )}
            </div>
            {mcpToken ? (
              <>
                <CodeBlock code={config} copyLabel={`Copy config for ${selectedClient.name}`} sensitive />
                <p className="mt-1.5 text-xs text-muted-foreground">Paste this only into {selectedClient.name} MCP settings. Never paste it into chat.</p>
              </>
            ) : (
              <div className="rounded-md border bg-muted/20 p-3 text-xs text-muted-foreground">
                {canIssuePersonalToken
                  ? 'Create a dedicated agent token first. It is shown only once and goes into MCP settings.'
                  : 'Connect with a personal pt_ or project sk_ credential to generate a complete MCP config.'}
              </div>
            )}
          </div>

          <div className="rounded-md border border-primary/30 bg-primary/5 p-3 text-xs leading-relaxed text-muted-foreground">
            After restarting the agent, ask it to call <code>get_onboarding_status</code>. Poolstatis marks MCP connected only after that real tool call reaches the project.
          </div>
          {MCP_RUNNER.packageStatus !== 'published' && <p className="text-xs text-amber-600">The configured MCP runner is not marked as published for this deploy.</p>}
          {error && <ErrorNote>{error}</ErrorNote>}
      </div>
    </section>
  );
}

function relativeTime(value: string): string {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return value;
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  return new Date(timestamp).toLocaleDateString();
}

function KeyMap() {
  return (
    <Panel title="Which key goes where?">
      <div className="grid gap-3 sm:grid-cols-3">
        <KeyUse prefix="pk_" title="Product environment" body="Write-only. Put it in the product or hosting environment. Never paste it into chat." />
        <KeyUse prefix="pt_" title="Agent MCP settings" body="Organization-wide read/manage access. Store only in MCP settings or a secret store." />
        <KeyUse prefix="sk_" title="Project administration" body="Project-scoped read/manage access. Never ship it in browser code." />
      </div>
    </Panel>
  );
}

function HttpExample({ serverUrl }: { serverUrl: string }) {
  const code = `curl -X POST ${serverUrl}/i/v1/events \\
  -H 'Authorization: Bearer pk_…' \\
  -H 'content-type: application/json' \\
  -d '{"events":[{"event":"signup.completed","distinct_id":"u_123"}]}'`;
  return <Panel title="Send an event over HTTP"><CodeBlock code={code} copyLabel="Copy HTTP example" /></Panel>;
}

function WebhookSetup({ project }: { project: string }) {
  const { client } = useStore();
  const destinations = useAsync(() => client!.webhookDestinations(project), [project]);
  const [name, setName] = useState('product_ops');
  const [url, setUrl] = useState('');
  const [authorization, setAuthorization] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const configure = async () => {
    setBusy('configure'); setError(null);
    try {
      await client!.configureWebhook(project, { name, url, ...(authorization ? { authorization } : {}) });
      setUrl(''); setAuthorization(''); destinations.reload();
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Could not configure webhook'); }
    finally { setBusy(null); }
  };
  const verify = async (id: string) => {
    setBusy(id); setError(null);
    try { await client!.testWebhook(project, id); destinations.reload(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Could not queue test delivery'); }
    finally { setBusy(null); }
  };
  return (
    <Panel title="Decision webhook" right={<span className="text-xs text-muted-foreground">Optional</span>}>
      <p className="mb-3 text-sm text-muted-foreground">Send approved product decisions to another system. This is unrelated to initial analytics setup.</p>
      <div className="grid gap-2 md:grid-cols-[12rem_1fr_1fr_auto]">
        <Input aria-label="Webhook name" value={name} onChange={(event) => setName(event.target.value)} placeholder="product_ops" />
        <Input aria-label="Webhook URL" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://hooks.example.com/…" />
        <Input aria-label="Webhook authorization" type="password" value={authorization} onChange={(event) => setAuthorization(event.target.value)} placeholder="Authorization (optional)" />
        <Button onClick={() => void configure()} disabled={busy === 'configure' || !url || !name}>{busy === 'configure' ? 'Saving…' : 'Configure'}</Button>
      </div>
      <div className="mt-4 space-y-2">
        {destinations.loading ? <Loading what="reading webhook status…" /> : destinations.data?.map((destination) => (
          <div key={destination.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3">
            <div>
              <div className="text-sm font-medium">{destination.name}</div>
              <code className="text-xs text-muted-foreground">{destination.masked_url}</code>
              {destination.last_error && <div className="mt-1 text-xs text-destructive">{destination.last_error}</div>}
            </div>
            <div className="flex items-center gap-2">
              <Badge variant={destination.status === 'verified' ? 'default' : destination.status === 'error' ? 'destructive' : 'outline'}>{destination.status}</Badge>
              <Button size="sm" variant="outline" onClick={() => void verify(destination.id)} disabled={busy === destination.id}>{busy === destination.id ? 'Queued…' : 'Queue test'}</Button>
            </div>
          </div>
        ))}
      </div>
      {error && <div className="mt-3"><ErrorNote>{error}</ErrorNote></div>}
    </Panel>
  );
}

function DangerZone({ slug, env }: { slug: string; env: string }) {
  const { client, tokenKind } = useStore();
  const [action, setAction] = useState<null | { scope: 'events' | 'entities' | 'all'; title: string; del: string[] }>(null);
  const [result, setResult] = useState<string | null>(null);

  if (tokenKind !== 'secret') {
    return <Card className="border-destructive/40"><div className="p-5 text-xs text-muted-foreground">Data deletion requires a project <code>sk_</code> secret key.</div></Card>;
  }

  const rows: Array<{ scope: 'events' | 'entities' | 'all'; title: string; description: string; del: string[] }> = [
    { scope: 'events', title: 'Purge event data', description: `Delete all events for ${env}.`, del: [`all events (${env})`, 'computed funnels and health'] },
    { scope: 'entities', title: 'Purge entities', description: `Delete all entities for ${env}.`, del: [`all entities (${env})`] },
    { scope: 'all', title: 'Purge everything', description: `Delete all events and entities for ${env}.`, del: [`all events and entities (${env})`] },
  ];

  return (
    <Card className="gap-0 overflow-hidden border-destructive/40 py-0">
      <div className="border-b border-destructive/20 px-5 py-3.5"><h3 className="serif text-lg text-destructive">Danger zone · {env}</h3></div>
      {result && <div className="m-4 rounded-md border bg-muted/40 px-4 py-3 text-sm">{result}</div>}
      {rows.map((row) => (
        <div key={row.scope} className="flex items-center justify-between gap-4 border-b px-5 py-3.5 last:border-0">
          <div><div className="text-sm">{row.title}</div><div className="mt-0.5 text-xs text-muted-foreground">{row.description}</div></div>
          <Button variant="destructive" onClick={() => setAction({ scope: row.scope, title: row.title, del: row.del })}>{row.title}</Button>
        </div>
      ))}
      {action && (
        <DangerConfirm
          title={`${action.title}?`}
          blastRadius={<>This purges <strong className="font-mono text-foreground">{env}</strong> data and cannot be undone.</>}
          willDelete={action.del}
          willKeep={['metric and funnel definitions', 'API keys', 'entity-type schema']}
          matchValue={slug}
          matchLabel="Type the project slug to confirm"
          confirmLabel={action.title}
          onCancel={() => setAction(null)}
          onConfirm={async () => {
            const response = await client!.purgeData(slug, { env, scope: action.scope, confirm_slug: slug });
            setResult(`Purged ${env}: ${response.events_deleted} events, ${response.entities_deleted} entities removed.`);
            setAction(null);
          }}
        />
      )}
    </Card>
  );
}

function KeyUse({ prefix, title, body }: { prefix: string; title: string; body: string }) {
  return (
    <div className="rounded-md border bg-muted/20 p-3.5">
      <Badge variant="outline" className="font-mono">{prefix}</Badge>
      <div className="mt-2 text-sm font-medium">{title}</div>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{body}</p>
    </div>
  );
}

function CodeBlock({ code, copyLabel, sensitive }: { code: string; copyLabel: string; sensitive?: boolean }) {
  const [revealed, setRevealed] = useState(!sensitive);
  const shown = revealed ? code : code.replace(/(POOLSTATIS_TOKEN"?:\s*"?)([^"\s\n}]+)/, '$1pt_••••••••••••');
  return (
    <div className="relative">
      <div className="absolute right-2 top-2 z-10 flex gap-2">
        {sensitive && <Button variant="outline" size="sm" onClick={() => setRevealed((value) => !value)}>{revealed ? 'Hide token' : 'Reveal token'}</Button>}
        <CopyButton value={code}>{copyLabel}</CopyButton>
      </div>
      <pre className={cn('overflow-auto rounded-md border bg-background p-4 pr-40 text-xs leading-relaxed', sensitive && !revealed && 'select-none')}>{shown}</pre>
    </div>
  );
}
