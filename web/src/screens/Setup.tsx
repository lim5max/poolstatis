import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2 } from '@/components/icons';
import { useStore, useAsync } from '../store';
import { MCP_CLIENTS, MCP_RUNNER, mcpClientById, mcpServerConfig, type McpClientId } from '../mcpClients';
import {
  CopyButton,
  ProductConnectionGuide,
  type AgentId,
  type SetupTaskResponse,
} from '../components/ProductConnectionGuide';
import { Panel, Loading, DangerConfirm, ErrorNote } from '../components/ui';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import {
  captureProductTelemetry,
  telemetryEnvironment,
  telemetryLatencyBucket,
} from '../productTelemetry';
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue,
} from '@/components/ui/select';

const SKILLS_SOURCE = 'https://github.com/lim5max/poolstatis';
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
  goal_ids: string[];
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
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [mcpOpen, setMcpOpen] = useState(() => window.location.hash === '#agent-access');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const blockedTracked = useRef(new Set<string>());
  const mcpConnectedTracked = useRef(false);
  const publicUrl =
    (import.meta.env.VITE_POOLSTATIS_PUBLIC_URL as string | undefined) ||
    (import.meta.env.VITE_POOLSTATIS_API_URL as string | undefined) ||
    'https://api.poolstatis.xyz';
  const serverUrl = (baseUrl || publicUrl).replace(/\/$/, '');
  const selectedProject = projects.find((item) => item.slug === project);
  const projectName = selectedProject?.name ?? project ?? 'Product';
  const setupClient = client as unknown as SetupClient | null;

  const proof = useAsync(
    () => project ? client!.onboardingStatus(project, env) : Promise.resolve(null),
    [project, env],
  );
  const intent = useAsync(
    () => project && setupClient && typeof setupClient.projectIntent === 'function'
      ? setupClient.projectIntent(project)
      : Promise.resolve({ intent: null }),
    [project],
  );
  const standard = useAsync(
    () => advancedOpen ? client!.standard() : Promise.resolve(null),
    [advancedOpen],
  );

  const sourceGate = proof.data?.gates.find((gate) => gate.key === 'data_source_connected');
  const eventGate = proof.data?.gates.find((gate) => gate.key === 'first_event_observed');
  const agentGate = proof.data?.gates.find((gate) => gate.key === 'agent_connected');
  const eventSeen = eventGate?.complete ?? false;
  const lastSeen = typeof eventGate?.evidence.last_seen === 'string' ? eventGate.evidence.last_seen : null;
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
  const preferLlm = Boolean(intent.data?.intent?.custom_goal);
  const serverBlocker = proof.data?.next_blocker ?? null;
  const blockerCode = serverBlocker ? normalizeBlockerKey(serverBlocker.key) : null;

  useEffect(() => {
    if (!project || eventSeen) return;
    const timer = window.setInterval(() => proof.reload(), 5000);
    return () => window.clearInterval(timer);
    // The reload callback is intentionally read from the latest render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventSeen, project]);

  useEffect(() => {
    if (!blockerCode || blockedTracked.current.has(blockerCode)) return;
    blockedTracked.current.add(blockerCode);
    captureProductTelemetry('onboarding.blocked', { blocker: blockerCode }, { distinctId: account?.user?.id });
  }, [account?.user?.id, blockerCode]);

  useEffect(() => {
    if (!eventSeen || !agentGate?.complete || mcpConnectedTracked.current) return;
    mcpConnectedTracked.current = true;
    captureProductTelemetry('mcp.connected', {}, { distinctId: account?.user?.id });
  }, [account?.user?.id, agentGate?.complete, eventSeen]);

  const createIngestKey = async () => {
    if (!client || !project) return;
    setCreatingKey(true);
    setKeyError(null);
    try {
      const created = await client.issueKey(project, { kind: 'ingest', env, label: 'Setup guide' });
      setFreshIngestKey(created.token);
      proof.reload();
    } catch (error) {
      setKeyError((error as Error).message);
    } finally {
      setCreatingKey(false);
    }
  };

  const getSetupTask = useCallback(async (agentId: AgentId) => {
    if (!setupClient || !project || typeof setupClient.setupTask !== 'function') {
      throw new Error('Setup task generation is unavailable on this server.');
    }
    return setupClient.setupTask(project, { agent_id: agentId, prefer_llm: preferLlm });
  }, [preferLlm, project, setupClient]);

  if (!project) {
    return <Panel title="Setup"><p className="text-sm text-muted-foreground">Select a project first.</p></Panel>;
  }

  const sourceReady = sourceGate?.complete ?? false;
  const projectMode = intent.data?.intent?.project_mode;
  const reviewBlocker = serverBlocker ? needsRegistryReview(serverBlocker.key) : false;
  const blocker = proof.loading && !proof.data
    ? { kind: 'loading' as const, title: 'Checking connection', why: 'Reading the latest server proof for this project.' }
    : proof.error
      ? { kind: 'error' as const, title: 'Connection status unavailable', why: proof.error }
      : serverBlocker
        ? {
            kind: 'server' as const,
            title: blockerTitle(serverBlocker.key),
            why: serverBlocker.blocker ?? serverBlocker.next_action ?? 'Complete the next server-verified setup gate.',
          }
        : null;

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <header>
        <div className="mb-1 text-xs text-muted-foreground">{projectName} · {env}</div>
        <h1 className="serif text-3xl font-normal">Setup</h1>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">What is blocking this project from sending useful data?</p>
      </header>

      <div className="flex flex-wrap items-center justify-between gap-3 border-y py-3">
        <div className="text-sm font-medium">
          {eventSeen ? <>Connected <span className="font-normal text-muted-foreground">· {lastSeen ? `last event ${relativeTime(lastSeen)} · ` : ''}{env}</span></> : <>1 step left <span className="font-normal text-muted-foreground">· Send your first event</span></>}
        </div>
        {!eventSeen && <Button size="sm" onClick={() => setConnectionOpen(true)}>Continue setup</Button>}
      </div>

      {blocker && (
        <section className="rounded-lg border bg-muted/10 p-4" aria-live="polite">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-sm font-medium">{blocker.title}</h2>
              <p className="mt-1 text-xs text-muted-foreground">{blocker.why}</p>
            </div>
            {blocker.kind === 'error' && <Button size="sm" onClick={proof.reload}>Try again</Button>}
            {blocker.kind === 'server' && reviewBlocker && (
              <Button size="sm" onClick={() => navigate('/registry')}>Review proposed metrics</Button>
            )}
            {blocker.kind === 'server' && !reviewBlocker && intent.data?.intent && blockerCode && setupClient && typeof setupClient.setupTaskFeedback === 'function' && (
              <FixTaskAction
                key={blockerCode}
                projectSlug={project}
                env={env}
                preferLlm={preferLlm}
                client={setupClient}
                telemetryUserId={account?.user?.id}
              />
            )}
            {blocker.kind === 'server' && !reviewBlocker && !intent.loading && !intent.data?.intent && (
              <Button size="sm" onClick={() => setConnectionOpen(true)}>Continue setup</Button>
            )}
          </div>
        </section>
      )}

      <section className="overflow-hidden rounded-lg border bg-card" aria-label="Setup status">
        <SetupRow
          title="Product connection"
          status={eventSeen ? 'Connected' : sourceReady ? 'Waiting for event' : 'Needs setup'}
          description={eventSeen ? `Last server-verified event${lastSeen ? ` ${relativeTime(lastSeen)}` : ''}.` : 'Product key, SDK, and first server-verified event.'}
          action={connectionOpen ? 'Hide' : eventSeen ? 'View' : 'Continue'}
          onAction={() => setConnectionOpen((value) => !value)}
        />
        <SetupRow
          title="Tracking plan"
          status={intent.loading ? 'Checking' : intent.data?.intent ? `${intent.data.intent.goal_ids.length} goals` : 'Not set'}
          description={intent.data?.intent ? 'Selected outcomes shape the setup task and first answers.' : 'Existing projects keep working without choosing a mode.'}
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

      {connectionOpen && (
        <ProductConnectionGuide
          ingestKey={freshIngestKey}
          keyReady={sourceReady}
          serverUrl={serverUrl}
          projectName={projectName}
          projectSlug={project}
          projectMode={projectMode ?? 'product'}
          eventSeen={eventSeen}
          lastSeen={lastSeen}
          eventName={eventName}
          eventEnvironment={eventEnvironment}
          eventRegistered={eventRegistered}
          checking={proof.loading}
          creatingKey={creatingKey}
          error={keyError ?? proof.error}
          onCreateKey={() => void createIngestKey()}
          getSetupTask={getSetupTask}
          onCheck={proof.reload}
          onOpenProject={() => navigate(projectMode === 'website' ? '/analyze/web' : projectMode === 'product' ? '/analyze/product' : '/')}
          onReviewMetrics={() => navigate('/registry')}
          telemetryUserId={account?.user?.id}
          telemetryEnvironment={telemetryEnvironment(env)}
        />
      )}

      {mcpOpen && (
        <OptionalMcp
          serverUrl={serverUrl}
          storedToken={tokenKind === 'personal' || tokenKind === 'secret' ? token : null}
          canIssuePersonalToken={tokenKind === 'user'}
          connected={agentGate?.complete ?? false}
        />
      )}

      {advancedOpen && (
        <section className="space-y-4 rounded-lg border bg-card p-4" aria-label="Advanced setup and administration">
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

function FixTaskAction({ projectSlug, env, preferLlm, client, telemetryUserId }: {
  projectSlug: string;
  env: string;
  preferLlm: boolean;
  client: SetupClient;
  telemetryUserId?: string | null;
}) {
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [fallbackTask, setFallbackTask] = useState<{ task: string; blocker: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

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
        prefer_llm: preferLlm,
        kind: 'fix',
        env,
      });
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
        setFallbackTask({ task, blocker: responseBlocker });
        return;
      }
      await recordFeedback(responseBlocker);
      setCopied(true);
      captureProductTelemetry('onboarding.task_copied', { agent_id: 'codex' }, { distinctId: telemetryUserId });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not prepare the fix task.');
    } finally {
      setBusy(false);
    }
  };

  const confirmManualCopy = async () => {
    setBusy(true);
    setError(null);
    try {
      if (!fallbackTask) return;
      await recordFeedback(fallbackTask.blocker);
      setFallbackTask(null);
      setCopied(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not record the copied task.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex max-w-xl flex-col items-start gap-2">
      <Button size="sm" onClick={() => void copyFixTask()} disabled={busy || Boolean(fallbackTask)}>
        {busy && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
        {busy ? 'Preparing task…' : copied ? 'Fix task copied' : 'Copy fix task'}
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

function normalizeBlockerKey(value: string): string | null {
  const normalized = value.trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 100)
    .replace(/_+$/g, '');
  return /^[a-z][a-z0-9_]*$/.test(normalized) ? normalized : null;
}

function needsRegistryReview(key: string): boolean {
  return key === 'metrics_activated' || key === 'data_quality_accepted';
}

function blockerTitle(key: string): string {
  switch (key) {
    case 'workspace_created': return 'Workspace setup is incomplete';
    case 'data_source_connected': return 'Product connection is incomplete';
    case 'first_event_observed': return 'No events yet';
    case 'metrics_activated': return 'Metrics need review';
    case 'data_quality_accepted': return 'Data quality needs review';
    case 'first_query_produced': return 'No trusted answer yet';
    case 'first_decision_saved': return 'No decision saved yet';
    case 'agent_connected': return 'Agent access is not connected';
    default: return 'Setup needs attention';
  }
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
  const skillsCommand = `pnpm dlx skills add ${SKILLS_SOURCE} --skill ${SKILLS} --agent ${skillTarget} -y`;

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
