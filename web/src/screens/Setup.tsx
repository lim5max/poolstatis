import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, Copy } from '@/components/icons';
import { ClaudeCodeLogo } from '@/components/logos/claude-code';
import { ClaudeLogo } from '@/components/logos/claude';
import { CodexLogo } from '@/components/logos/codex';
import { CursorLogo } from '@/components/logos/cursor';
import { WindsurfLogo } from '@/components/logos/windsurf';
import { ClineLogo } from '@/components/logos/cline';
import { ZedLogo } from '@/components/logos/zed';
import { ContinueLogo } from '@/components/logos/continue';
import { ReplitLogo } from '@/components/logos/replit';
import { OpenCodeLogo } from '@/components/logos/opencode';
import { useStore, useAsync } from '../store';
import { MCP_CLIENTS, MCP_RUNNER, mcpClientById, mcpClientConfig, type McpClientId, type McpClientLogo } from '../mcpClients';
import { ANALYTICS_JOBS, buildAnalyticsAgentRequest, type AnalyticsJobId } from '../onboardingIntent';
import { PUBLISHED_MCP_TOOL_GROUPS } from '../mcpPublishedContract';
import { Panel, Loading, DangerConfirm, ErrorNote, RecoverableError } from '../components/ui';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import type { OnboardingGate } from '../api/types';
import { siWarp } from 'simple-icons';

const SKILL_NAMES = ['poolstatis-instrument', 'poolstatis-analyze', 'poolstatis-maintain'] as const;
const SKILLS_SOURCE = 'https://github.com/lim5max/poolstatis';
const skillInstallCommand = (agent: 'codex' | 'claude-code' | "'*'") =>
  `pnpm dlx skills add ${SKILLS_SOURCE} --skill ${SKILL_NAMES.join(' ')} --agent ${agent} -y`;
const SKILLS_VERIFY_COMMAND = 'pnpm dlx skills list --json';
type QueryPromptId = 'quick' | 'compare' | 'diagnose';

function skillAgentForClient(clientId: McpClientId): 'codex' | 'claude-code' | "'*'" {
  if (clientId === 'codex') return 'codex';
  if (clientId === 'claude-code') return 'claude-code';
  return "'*'";
}

export function Setup() {
  const { client, baseUrl, project, env } = useStore();
  const [clientId, setClientId] = useState<McpClientId>('claude-code');
  const [configCopied, setConfigCopied] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [requestOpen, setRequestOpen] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [queryPromptId, setQueryPromptId] = useState<QueryPromptId>('quick');
  const [jobId, setJobId] = useState<AnalyticsJobId>('activation');
  const [outcome, setOutcome] = useState('');
  const publicUrl =
    (import.meta.env.VITE_POOLSTATIS_PUBLIC_URL as string | undefined) ||
    (import.meta.env.VITE_POOLSTATIS_API_URL as string | undefined) ||
    'https://api.poolstatis.xyz';
  const serverUrl = baseUrl || publicUrl;
  const slug = project ?? 'your-project';
  const std = useAsync(
    () => advancedOpen ? client!.standard() : Promise.resolve(null),
    [advancedOpen],
  );
  const proof = useAsync(
    () => project ? client!.onboardingStatus(project, env) : Promise.resolve(null),
    [project, env],
  );
  const selectedClient = mcpClientById(clientId);
  const selectedJob = ANALYTICS_JOBS.find((job) => job.id === jobId) ?? ANALYTICS_JOBS[0]!;

  const mcpToken = '<replace-with-pt-or-sk>';
  const normalizedServerUrl = serverUrl.replace(/\/$/, '');
  const mcpConnection = mcpClientConfig(clientId, MCP_RUNNER.command, MCP_RUNNER.args, normalizedServerUrl, mcpToken);
  const mcpConfig = mcpConnection.code;
  const mcpCommand = [MCP_RUNNER.command, ...MCP_RUNNER.args].join(' ');
  const mcpEnv = `POOLSTATIS_URL=${normalizedServerUrl}\nPOOLSTATIS_TOKEN=${mcpToken}`;
  const ingestCurl = `curl -X POST ${serverUrl}/i/v1/events \\
  -H 'Authorization: Bearer pk_…' \\
  -H 'content-type: application/json' \\
  -d '{"events":[{"event":"signup.completed","distinct_id":"u_123","properties":{"plan":"pro"}}]}'`;
  const queryPrompts: Array<{ id: QueryPromptId; label: string; prompt: string }> = [
    {
      id: 'quick',
      label: 'Quick trend',
      prompt: `For Poolstatis project "${slug}" in env "${env}", call list_metrics for active metrics, choose one, and run query_trend for the last 7 days with a daily interval. Then call get_onboarding_status. Report the metric purpose, date range, grain, and result.`,
    },
    {
      id: 'compare',
      label: 'Compare periods',
      prompt: `For Poolstatis project "${slug}" in env "${env}", call list_metrics for active metrics, choose one, and run query_trend for the last 7 complete days and the preceding 7 days with the same daily interval. Report both totals, the descriptive change, grain, and date ranges. Do not claim causality.`,
    },
    {
      id: 'diagnose',
      label: 'Diagnose gaps',
      prompt: `For Poolstatis project "${slug}" in env "${env}", inspect get_project_schema and list_ingest_warnings, choose an active metric, then run query_trend for the last 7 days. If the query cannot run, report the exact blocker and next action instead of inventing a result. Finish with get_onboarding_status.`,
    },
  ];
  const selectedQueryPrompt = queryPrompts.find((option) => option.id === queryPromptId) ?? queryPrompts[0]!;
  const agentRequest = project
    ? buildAnalyticsAgentRequest({ jobId, outcome, project, env })
    : null;

  return (
    <div className="max-w-5xl space-y-5">
      <header className="max-w-2xl">
        <h1 className="serif text-3xl text-balance">Add analytics with your agent</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          Choose what you want to learn, give one request to the coding agent already in your repository, and follow server evidence to the first trustworthy answer.
        </p>
      </header>

      <Panel title="What do you want to learn?" right={<Badge variant="outline">one agent request</Badge>}>
        <div className="grid grid-cols-2 gap-2" role="group" aria-label="Analytics job">
          {ANALYTICS_JOBS.map((job) => (
            <button
              key={job.id}
              type="button"
              aria-pressed={jobId === job.id}
              onClick={() => setJobId(job.id)}
              className={cn(
                'rounded-md border p-3 text-left outline-none transition-colors hover:border-foreground/25 focus-visible:ring-2 focus-visible:ring-ring/50 sm:p-4',
                jobId === job.id ? 'border-primary bg-primary/5' : 'bg-muted/15',
              )}
            >
              <span className="block text-sm font-medium">{job.label}</span>
              <span className="mt-1 hidden text-xs leading-relaxed text-muted-foreground sm:block">{job.description}</span>
            </button>
          ))}
        </div>
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground sm:hidden">{selectedJob.description}</p>
        <div className="mt-4 max-w-2xl space-y-1.5">
          <label htmlFor="analytics-outcome" className="text-xs font-medium text-muted-foreground">Product-specific outcome · optional</label>
          <Input
            id="analytics-outcome"
            value={outcome}
            maxLength={240}
            onChange={(event) => setOutcome(event.target.value)}
            placeholder="For example: more teams invite a second member"
          />
        </div>
      </Panel>

      <Panel
        title="Give this to your agent"
        right={project ? <Badge variant="outline" className="font-mono">{project} · {env}</Badge> : undefined}
      >
        {agentRequest
          ? <>
              <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
                <span className="font-medium text-foreground">{selectedJob.label}.</span>{' '}
                One secret-free request tells the agent to inspect the product, instrument the smallest trustworthy loop, and return server evidence.
              </p>
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <CopyButton value={agentRequest} variant="default" className="h-9">Copy request</CopyButton>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-9"
                  aria-expanded={requestOpen}
                  aria-controls="full-agent-request"
                  onClick={() => setRequestOpen((value) => !value)}
                >
                  {requestOpen ? 'Hide full request' : 'View full request'}
                </Button>
              </div>
              {requestOpen && <div id="full-agent-request" className="mt-4"><CodeBlock code={agentRequest} /></div>}
            </>
          : <p className="text-sm text-muted-foreground">Choose a project to generate a scoped request.</p>}
      </Panel>

      <Panel
        title="Server progress"
        right={<div className="flex items-center gap-2">
          <Badge variant="outline" className="hidden sm:inline-flex">server evidence</Badge>
          <Button variant="ghost" size="sm" onClick={proof.reload} disabled={proof.loading}>Refresh</Button>
        </div>}
      >
        {!project
          ? <p className="text-sm text-muted-foreground">Choose a project to read its setup proof.</p>
          : proof.loading
            ? <Loading what="Checking setup proof…" />
            : proof.error
              ? <div className="space-y-3"><ErrorNote>{proof.error}</ErrorNote><Button variant="outline" size="sm" onClick={proof.reload}>Try again</Button></div>
              : proof.data
                ? <ProofSummary gates={proof.data.gates} nextBlocker={proof.data.next_blocker} />
                : null}
      </Panel>

      <Panel
        title={<h2>Prerequisite 1 · Agent connection</h2>}
        right={<Badge variant="outline">{mcpConnection.verifiedFormat ? 'verified host format' : 'generic stdio fields'}</Badge>}
      >
        <p className="mb-4 text-sm text-muted-foreground">Choose the agent that edits your product repository, add the server, then restart that agent.</p>
        <div className="max-w-sm">
          <div className="mb-2 text-xs font-medium text-muted-foreground">Coding agent</div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" className="h-11 w-full justify-start px-3" aria-label={`Coding agent: ${selectedClient.name}`}>
                <McpClientLogoMark logo={selectedClient.logo} className="size-7" />
                <span className="min-w-0 flex-1 truncate text-left">{selectedClient.name}</span>
                <span className="text-xs text-muted-foreground">Change</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-h-72 w-72 overflow-y-auto">
              {MCP_CLIENTS.map((profile) => (
                <DropdownMenuItem
                  key={profile.id}
                  onClick={() => setClientId(profile.id)}
                  className="gap-3 py-2"
                >
                  <McpClientLogoMark logo={profile.logo} className="size-7" />
                  <span className="min-w-0 flex-1 truncate">{profile.name}</span>
                  {profile.id === clientId && <Check className="size-4 shrink-0" />}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <p className="mt-2 text-xs text-muted-foreground">{selectedClient.pasteTarget}</p>
        </div>
        {MCP_RUNNER.packageStatus !== 'published' && (
          <div className="mt-4 break-words rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-xs text-amber-950 dark:text-amber-100 [&_code]:break-all">
            Registry install is disabled for this deploy. The config below uses the exact local Core runner; replace <code>&lt;path-to-poolstatis-core&gt;</code> with its checkout path. Set <code>VITE_POOLSTATIS_MCP_PACKAGE_PUBLISHED=true</code> only after the pinned public package is verified.
          </div>
        )}
        <div className="mt-4 flex flex-wrap gap-2">
          <CopyButton value={mcpConfig} onCopied={() => setConfigCopied(true)} onFailed={() => setConfigOpen(true)}>
            {mcpConnection.verifiedFormat ? 'Copy MCP config' : 'Copy stdio fields'}
          </CopyButton>
          <CopyButton value={mcpCommand} onFailed={() => setConfigOpen(true)}>Copy command</CopyButton>
          <CopyButton value={mcpEnv} onFailed={() => setConfigOpen(true)}>Copy environment</CopyButton>
        </div>
        <div aria-live="polite" role="status" className="mt-3 min-h-5 text-xs text-muted-foreground">
          {configCopied ? 'Connection values copied. This action does not verify MCP use.' : 'No server evidence changes until an MCP-marked request reaches the server.'}
        </div>
        <div className="mt-4 rounded-md border border-primary/30 bg-primary/5 px-4 py-3 text-xs text-muted-foreground">
          Replace <code>&lt;replace-with-pt-or-sk&gt;</code> with a personal <code>pt_</code> token or project <code>sk_</code> key in your local MCP client. Setup never copies the current session credential.
        </div>
        <div className="mt-4 rounded-md border bg-muted/20">
          <button
            type="button"
            className="w-full rounded-md px-4 py-3 text-left text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            aria-expanded={configOpen}
            aria-controls="mcp-config-details"
            onClick={() => setConfigOpen((value) => !value)}
          >
            {configOpen ? 'Hide config and client steps' : 'View config and client steps'}
          </button>
          {configOpen && <div id="mcp-config-details" className="space-y-4 border-t p-4">
            <div className="text-xs text-muted-foreground">
              <span className="font-medium text-foreground">{mcpConnection.label}.</span>{' '}
              {mcpConnection.verifiedFormat
                ? 'The structure matches the current host documentation.'
                : 'The host-specific file shape is not asserted; enter these command, args, and env values in that host.'}
            </div>
            <ol className="grid gap-2 md:grid-cols-3">
              {selectedClient.setupSteps.map((step, index) => (
                <li key={step} className="rounded-md bg-background p-3 text-xs leading-relaxed text-muted-foreground">
                  <span className="mr-2 font-medium text-foreground">{index + 1}.</span>{step}
                </li>
              ))}
            </ol>
            <CodeBlock code={mcpConfig} />
          </div>}
        </div>
      </Panel>

      <SkillsInstall clientId={clientId} />

      <section className="rounded-xl border bg-card">
        <button
          type="button"
          className="flex w-full items-center justify-between gap-4 rounded-xl px-5 py-4 text-left outline-none transition-colors hover:bg-muted/35 focus-visible:ring-2 focus-visible:ring-ring/50"
          aria-expanded={manualOpen}
          aria-controls="manual-setup"
          aria-label={manualOpen ? 'Hide manual setup and recovery' : 'Show manual setup and recovery'}
          onClick={() => setManualOpen((value) => !value)}
        >
          <span>
            <span className="block text-sm font-medium">Manual setup and recovery</span>
            <span className="mt-1 block text-xs text-muted-foreground">Verify MCP use, send an event manually, or run a focused query prompt.</span>
          </span>
          <span className="text-xs text-muted-foreground">{manualOpen ? 'Hide' : 'Show'}</span>
        </button>
        {manualOpen && <div id="manual-setup" className="space-y-4 border-t p-4 md:p-5">
          <Panel title="Verify MCP use">
            <p className="text-sm text-muted-foreground">
              Ask the agent to call <code>get_onboarding_status</code> with project <code>{slug}</code> and env <code>{env}</code>, then refresh server progress. “Last MCP-marked use” records a marked request and time; it is not a heartbeat or transport attestation.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={proof.reload} disabled={proof.loading}>Refresh server progress</Button>
              <Button asChild variant="ghost" size="sm"><Link to="/keys">Review MCP tokens</Link></Button>
            </div>
          </Panel>

          <Panel title="Send a real event manually">
            <div className="mb-4 rounded-md border bg-muted/20 p-4">
              <div className="text-sm font-medium">Activate a metric before sending</div>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                Register the metric through MCP, then review and activate it. New agent-created metrics stay proposed until you approve them.
              </p>
              <Button asChild variant="outline" size="sm" className="mt-3"><Link to="/registry">Review and activate metric</Link></Button>
            </div>
            <p className="text-sm text-muted-foreground">
              Use a write-only <code>pk_</code> key and replace the example with a real event covered by an active metric. The placeholder below never exposes a saved credential.
            </p>
            <div className="mt-4"><CodeBlock code={ingestCurl} /></div>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button asChild size="sm"><Link to="/data">Inspect accepted data</Link></Button>
              <Button asChild variant="outline" size="sm"><Link to="/registry">Review metrics</Link></Button>
            </div>
          </Panel>

          <Panel title="Run a focused query manually">
            <div className="flex flex-wrap gap-2" aria-label="Query prompt">
              {queryPrompts.map((option) => (
                <Button
                  key={option.id}
                  type="button"
                  variant={queryPromptId === option.id ? 'default' : 'outline'}
                  size="sm"
                  aria-pressed={queryPromptId === option.id}
                  onClick={() => setQueryPromptId(option.id)}
                >
                  {option.label}
                </Button>
              ))}
            </div>
            <div className="mt-4 rounded-md border bg-muted/20 p-4 text-sm leading-relaxed">{selectedQueryPrompt.prompt}</div>
            <div className="mt-4 flex flex-wrap gap-2">
              <CopyButton value={selectedQueryPrompt.prompt}>Copy {selectedQueryPrompt.label.toLowerCase()} prompt</CopyButton>
              <Button asChild variant="outline" size="sm"><Link to="/measurement">Check measurement trust</Link></Button>
            </div>
          </Panel>
        </div>}
      </section>

      <section className="rounded-xl border bg-card">
        <button
          type="button"
          className="flex w-full items-center justify-between gap-4 rounded-xl px-5 py-4 text-left outline-none transition-colors hover:bg-muted/35 focus-visible:ring-2 focus-visible:ring-ring/50"
          aria-expanded={advancedOpen}
          aria-controls="advanced-setup"
          aria-label={advancedOpen ? 'Hide advanced setup' : 'Show advanced setup'}
          onClick={() => setAdvancedOpen((value) => !value)}
        >
          <span>
            <span className="block text-sm font-medium">Advanced setup</span>
            <span className="mt-1 block text-xs text-muted-foreground">Key roles, HTTP, webhooks, tool reference, standard, and data deletion.</span>
          </span>
          <span className="text-xs text-muted-foreground">{advancedOpen ? 'Hide' : 'Show'}</span>
          <span className="sr-only">{advancedOpen ? 'Hide advanced setup' : 'Show advanced setup'}</span>
        </button>
        {advancedOpen && <div id="advanced-setup" className="space-y-4 border-t p-4 md:p-5">
          <Panel title="Key roles">
            <div className="grid grid-cols-1 gap-3.5 md:grid-cols-3">
              <KeyUse prefix="sk_" title="Project admin" body="Reads and manages one project." />
              <KeyUse prefix="pk_" title="Product ingest" body="Writes events and entities for one environment." />
              <KeyUse prefix="pt_" title="Organization MCP" body="Lets an agent discover projects across the organization." />
            </div>
          </Panel>
          <Panel title="HTTP ingest">
            <p className="mb-3 text-sm text-muted-foreground">Issue a <code>pk_</code> key in Keys, then send a real event.</p>
            <CodeBlock code={ingestCurl} />
          </Panel>
          {project && <WebhookSetup project={project} />}
          <Panel title="MCP tool reference">
            <div className="grid grid-cols-1 gap-3.5 md:grid-cols-2">
              {PUBLISHED_MCP_TOOL_GROUPS.map(([group, tools]) => (
                <div key={group} className="min-w-0">
                  <div className="mb-2 text-xs font-medium text-muted-foreground">{group}</div>
                  <div className="flex flex-wrap gap-1.5">{tools.map((tool) => <Badge key={tool} variant="outline" className="max-w-full whitespace-normal break-all font-mono text-xs font-normal">{tool}</Badge>)}</div>
                </div>
              ))}
            </div>
            <p className="mt-3.5 text-xs text-muted-foreground">Resources: <code>poolstatis://standard/instrumentation</code> and <code>poolstatis://{slug}/schema</code>.</p>
          </Panel>
          <Panel title="Instrumentation standard">
            {std.loading
              ? <Loading what="Loading the standard…" />
              : std.error
                ? <RecoverableError onRetry={std.reload}>{std.error}</RecoverableError>
                : <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-md border bg-background p-4 text-xs leading-relaxed">{std.data}</pre>}
          </Panel>
          <div>
            <h2 className="mb-3 text-sm font-medium text-destructive">Data deletion</h2>
            <DangerZone slug={slug} env={env} />
          </div>
        </div>}
      </section>
    </div>
  );
}

function SkillsInstall({ clientId }: { clientId: McpClientId }) {
  const client = mcpClientById(clientId);
  const command = skillInstallCommand(skillAgentForClient(clientId));

  return (
    <Panel title={<h2>Prerequisite 2 · Poolstatis skills</h2>}>
      <div className="grid gap-4 lg:grid-cols-[0.8fr_1.2fr]">
        <div>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Add the Poolstatis workflow to the same agent you selected above.
          </p>
          <div className="mt-4 grid gap-2">
            <SkillSummary name="poolstatis-instrument" body="Plan, register, implement, and verify purpose-first tracking." />
            <SkillSummary name="poolstatis-analyze" body="Choose a typed query and interpret its grain and purpose." />
            <SkillSummary name="poolstatis-maintain" body="Audit drift, warnings, coverage, and metric lifecycle." />
          </div>
          <div className="mt-4 flex flex-wrap gap-x-4 gap-y-2 text-xs">
            <a className="text-primary underline-offset-4 hover:underline" href="https://poolstatis.xyz/docs/quickstart" target="_blank" rel="noreferrer">Public quickstart</a>
            <a className="text-primary underline-offset-4 hover:underline" href="https://poolstatis.xyz/docs/standard" target="_blank" rel="noreferrer">Instrumentation standard</a>
            <a className="text-primary underline-offset-4 hover:underline" href="https://poolstatis.xyz/docs/mcp-tools" target="_blank" rel="noreferrer">MCP reference</a>
          </div>
        </div>
        <div className="min-w-0 space-y-3">
          <div className="min-w-0 rounded-md border bg-muted/20 p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="flex min-w-0 items-center gap-3">
                <McpClientLogoMark logo={client.logo} className="size-9" />
                <div className="min-w-0">
                  <div className="text-sm font-medium">{client.name}</div>
                  <p className="mt-1 text-xs text-muted-foreground">Run in the product repository. This installs the current skill files from the repository; it does not pin a commit.</p>
                </div>
              </div>
              <CopyButton value={command}>Copy {client.name} install</CopyButton>
            </div>
            <code className="mt-3 block overflow-x-auto whitespace-pre rounded-md bg-background p-3 text-xs">{command}</code>
          </div>
          <div className="rounded-md border border-dashed p-4">
            <div className="text-sm font-medium">Verify installed</div>
            <p className="mt-1 text-xs text-muted-foreground">
              Run this in the product repo and confirm all three names appear. For a local Core checkout, replace the GitHub URL in the install command with its absolute path.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <CopyButton value={SKILLS_VERIFY_COMMAND}>Copy verify command</CopyButton>
              <code className="max-w-full overflow-x-auto whitespace-pre rounded-md bg-muted px-3 py-2 text-xs">{SKILLS_VERIFY_COMMAND}</code>
            </div>
          </div>
        </div>
      </div>
    </Panel>
  );
}

function SkillSummary({ name, body }: { name: string; body: string }) {
  return (
    <div className="rounded-md border bg-muted/20 p-3">
      <code className="text-xs font-medium text-foreground">{name}</code>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{body}</p>
    </div>
  );
}

const GATE_LABELS: Record<OnboardingGate['key'], string> = {
  workspace_created: 'Project created',
  agent_connected: 'Last MCP-marked use',
  data_source_connected: 'Data source ready',
  first_event_observed: 'First product observation',
  metrics_activated: 'Metric verified',
  data_quality_accepted: 'Data quality accepted',
  first_query_produced: 'First query produced',
  first_decision_saved: 'First answer saved',
};

function ProofSummary({ gates, nextBlocker }: { gates: OnboardingGate[]; nextBlocker: OnboardingGate | null }) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const completed = gates.filter((gate) => gate.complete);
  const current = nextBlocker ?? gates.find((gate) => !gate.complete) ?? null;

  return (
    <div className="space-y-4" aria-live="polite">
      <div className="grid gap-3 md:grid-cols-[minmax(0,0.4fr)_minmax(0,1fr)]">
        <div className="rounded-md border bg-muted/20 p-4">
          <div className="text-xs font-medium text-muted-foreground">Completion</div>
          <div className="mt-1 serif text-3xl tabular-nums">{completed.length} <span className="font-sans text-sm text-muted-foreground">of {gates.length}</span></div>
        </div>
        <div className={cn('rounded-md border p-4', current ? 'border-primary/35 bg-primary/5' : 'border-emerald-500/35 bg-emerald-500/5')} data-testid="current-setup-action">
          <div className="text-xs font-medium text-muted-foreground">{current ? 'Next action' : 'Setup verified'}</div>
          <div className="mt-1 text-sm font-medium">
            {current ? current.next_action ?? current.blocker ?? `Complete ${GATE_LABELS[current.key]}.` : 'All server checks are complete.'}
          </div>
          {current && <p className="mt-1 text-xs text-muted-foreground">Blocked at {GATE_LABELS[current.key].toLowerCase()}.</p>}
        </div>
      </div>

      {completed.length > 0 && (
        <div className="flex flex-wrap gap-2" aria-label="Completed setup checks">
          {completed.map((gate) => (
            <Badge key={gate.key} variant="outline" className="gap-1.5 font-normal">
              <Check className="size-3.5 text-emerald-600" />
              {GATE_LABELS[gate.key]}
            </Badge>
          ))}
        </div>
      )}

      <div className="rounded-md border bg-muted/10">
        <button
          type="button"
          className="flex w-full items-center justify-between gap-3 rounded-md px-4 py-3 text-left text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          aria-expanded={detailsOpen}
          aria-controls="setup-proof-details"
          onClick={() => setDetailsOpen((value) => !value)}
        >
          <span>{detailsOpen ? 'Hide all 8 checks' : 'View all 8 checks'}</span>
          <span className="text-xs font-normal text-muted-foreground">{completed.length}/{gates.length}</span>
        </button>
        {detailsOpen && (
          <ol id="setup-proof-details" className="divide-y border-t" aria-label="All setup checks">
            {gates.map((gate, index) => (
              <li key={gate.key} className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-3 px-4 py-3 sm:grid-cols-[auto_minmax(10rem,0.7fr)_minmax(0,1fr)] sm:items-center">
                <span
                  className={cn(
                    'flex size-7 shrink-0 items-center justify-center rounded-full border text-xs font-medium',
                    gate.complete ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600' : 'text-muted-foreground',
                  )}
                  aria-hidden="true"
                >
                  {gate.complete ? <Check className="size-4" /> : index + 1}
                </span>
                <div className="text-sm font-medium">{GATE_LABELS[gate.key]}</div>
                <p className="col-start-2 text-xs leading-relaxed text-muted-foreground sm:col-start-3">
                  {gate.complete ? formatGateEvidence(gate) : 'Waiting for server evidence.'}
                </p>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

function formatGateEvidence(gate: OnboardingGate): string {
  switch (gate.key) {
    case 'workspace_created':
      return String(gate.evidence.project ?? 'Verified by the server');
    case 'agent_connected':
      return `${String(gate.evidence.client ?? 'MCP client')} · ${formatEvidenceTime(gate.evidence.observed_at)}`;
    case 'data_source_connected':
      return gate.evidence.native
        ? `Active pk_ key · ${formatEvidenceTime(gate.evidence.native_key_created_at)}`
        : `Verified external source · ${formatEvidenceTime(gate.evidence.posthog_verified_at)}`;
    case 'first_event_observed':
      return gate.evidence.observation_source === 'posthog'
        ? `PostHog query · ${formatEvidenceTime(gate.evidence.posthog_query_at)}`
        : `${Number(gate.evidence.native_events).toLocaleString()} accepted · ${formatEvidenceTime(gate.evidence.last_seen)}`;
    case 'metrics_activated':
      return `${String(gate.evidence.metric_key ?? 'Metric')} · ${String(gate.evidence.source ?? 'source verified')}`;
    case 'data_quality_accepted':
      return typeof gate.evidence.issues === 'number'
        ? `${gate.evidence.issues.toLocaleString()} open data-quality issues`
        : 'Accepted by the server';
    case 'first_query_produced':
      return `${String(gate.evidence.source ?? 'native')} · ${formatEvidenceTime(gate.evidence.created_at)}`;
    case 'first_decision_saved':
      return `${String(gate.evidence.title ?? gate.evidence.outcome ?? 'Evidence-backed answer')} · ${formatEvidenceTime(gate.evidence.created_at)}`;
  }
}

function formatEvidenceTime(value: unknown) {
  if (typeof value !== 'string' || !value) return 'time not recorded';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'time not recorded' : date.toLocaleString();
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
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'could not configure webhook'); }
    finally { setBusy(null); }
  };
  const verify = async (id: string) => {
    setBusy(id); setError(null);
    try { await client!.testWebhook(project, id); destinations.reload(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'could not queue test delivery'); }
    finally { setBusy(null); }
  };
  return <Panel title="Decision webhook" right={<span className="text-xs text-muted-foreground">encrypted · outbox delivery · approval-gated</span>}>
    <p className="mb-3 text-sm text-muted-foreground">Send sanitized product impact to one generic destination. URL and authorization are write-only; an explicit test must succeed before decision actions can queue delivery.</p>
    <div className="grid gap-2 md:grid-cols-[12rem_1fr_1fr_auto]"><Input aria-label="Webhook name" value={name} onChange={(event) => setName(event.target.value)} placeholder="product_ops" /><Input aria-label="Webhook URL" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://hooks.example.com/…" /><Input aria-label="Webhook authorization" type="password" value={authorization} onChange={(event) => setAuthorization(event.target.value)} placeholder="Authorization (optional)" /><Button onClick={configure} disabled={busy === 'configure' || !url || !name}>{busy === 'configure' ? 'Saving…' : 'Configure'}</Button></div>
    <div className="mt-4 space-y-2">
      {destinations.loading
        ? <Loading what="reading webhook status…" />
        : destinations.error
          ? <RecoverableError onRetry={destinations.reload}>{destinations.error}</RecoverableError>
          : destinations.data?.map((destination) => <div key={destination.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"><div><div className="text-sm font-medium">{destination.name}</div><code className="text-xs text-muted-foreground">{destination.masked_url}</code>{destination.last_error && <div className="mt-1 text-xs text-destructive">{destination.last_error}</div>}</div><div className="flex items-center gap-2"><Badge variant={destination.status === 'verified' ? 'default' : destination.status === 'error' ? 'destructive' : 'outline'}>{destination.status}</Badge><Button size="sm" variant="outline" onClick={() => verify(destination.id)} disabled={busy === destination.id}>{busy === destination.id ? 'Queued…' : 'Queue test'}</Button></div></div>)}
    </div>
    {error && <div className="mt-3"><ErrorNote>{error}</ErrorNote></div>}
  </Panel>;
}

const MCP_LOGO_LABELS: Record<McpClientLogo, string> = {
  'claude-code': 'Claude Code',
  claude: 'Claude',
  codex: 'Codex',
  cursor: 'Cursor',
  warp: 'Warp',
  windsurf: 'Windsurf',
  vscode: 'VS Code',
  cline: 'Cline',
  zed: 'Zed',
  continue: 'Continue',
  replit: 'Replit',
  opencode: 'OpenCode',
  hermes: 'Hermes',
  custom: 'Custom MCP',
};

function McpClientLogoMark({ logo, className }: { logo: McpClientLogo; className?: string }) {
  return (
    <span
      aria-label={`${MCP_LOGO_LABELS[logo]} logo`}
      data-brand-logo={logo}
      className={cn('flex shrink-0 items-center justify-center rounded-md border bg-background', className)}
    >
      <McpBrandLogo logo={logo} />
    </span>
  );
}

function McpBrandLogo({ logo }: { logo: McpClientLogo }) {
  switch (logo) {
    case 'claude-code':
      return <ClaudeCodeLogo variant="icon-color" className="size-5" />;
    case 'claude':
      return <ClaudeLogo aria-hidden="true" className="size-5" />;
    case 'codex':
      return <CodexLogo variant="icon-color" className="size-5" />;
    case 'cursor':
      return <CursorLogo className="size-5 text-foreground" />;
    case 'warp':
      return <svg viewBox="0 0 24 24" aria-hidden="true" className="size-5" fill={`#${siWarp.hex}`}><path d={siWarp.path} /></svg>;
    case 'windsurf':
      return <WindsurfLogo aria-hidden="true" className="size-5" />;
    case 'vscode':
      return <svg viewBox="0 0 24 24" aria-hidden="true" className="size-5" fill="#23A8F2"><path d="M17.583 2.135a1.5 1.5 0 0 1 1.676.292l2.314 2.14A1.5 1.5 0 0 1 22 5.668v12.664a1.5 1.5 0 0 1-.427 1.1l-2.314 2.14a1.5 1.5 0 0 1-1.676.293l-7.24-3.487-4.236 3.306a1 1 0 0 1-1.278-.043l-2.55-2.325a1 1 0 0 1-.063-1.413L5.94 12 2.216 6.097a1 1 0 0 1 .063-1.413l2.55-2.325a1 1 0 0 1 1.278-.043l4.236 3.306 7.24-3.487ZM18 6.386l-5.51 5.615L18 17.614V6.386ZM6.002 7.43 3.94 12l2.062 4.57L9.405 12 6.002 7.43Z" /></svg>;
    case 'cline':
      return <ClineLogo aria-hidden="true" className="size-5 text-foreground" />;
    case 'zed':
      return <ZedLogo className="size-5 text-foreground" />;
    case 'continue':
      return <ContinueLogo aria-hidden="true" className="size-5 text-foreground" />;
    case 'replit':
      return <ReplitLogo variant="icon-color" className="size-5" />;
    case 'opencode':
      return <OpenCodeLogo aria-hidden="true" className="size-5 text-foreground" />;
    case 'hermes':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" className="size-5 text-foreground">
          <path d="M6 14.5c3.2-6.1 6.8-8.4 12-8.5-1.2 5.2-3.6 8.8-8.5 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M8 8.5H4.5M11 6.2H7.5M15 6h-2.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      );
    case 'custom':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" className="size-5 text-muted-foreground">
          <circle cx="7" cy="8" r="2.2" fill="currentColor" />
          <circle cx="17" cy="8" r="2.2" fill="currentColor" />
          <circle cx="12" cy="17" r="2.2" fill="currentColor" />
          <path d="M8.8 9.4 11 15M15.2 9.4 13 15M9.4 8h5.2" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      );
  }
}

function KeyUse({ prefix, title, body }: { prefix: string; title: string; body: string }) {
  return (
    <div className="rounded-md border bg-muted/20 p-3.5">
      <Badge variant="outline" className="font-mono">{prefix}</Badge>
      <div className="font-medium mt-2">{title}</div>
      <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{body}</p>
    </div>
  );
}

function DangerZone({ slug, env }: { slug: string; env: string }) {
  const { client, tokenKind } = useStore();
  const [action, setAction] = useState<null | { scope: 'events' | 'entities' | 'all'; title: string; del: string[] }>(null);
  const [result, setResult] = useState<string | null>(null);

  if (tokenKind !== 'secret') {
    return <Card className="border-destructive/40"><div className="p-5 text-xs text-muted-foreground">Data purge requires a project <code>secret</code> key (<code>sk_</code>). You're connected with a {tokenKind} token.</div></Card>;
  }

  const rows: Array<{ scope: 'events' | 'entities' | 'all'; t: string; d: string; del: string[] }> = [
    { scope: 'events', t: 'Purge event data', d: `Delete all events for the ${env} environment.`, del: [`all events (env: ${env})`, 'computed funnels & health'] },
    { scope: 'entities', t: 'Purge entities', d: `Delete all entity rows for the ${env} environment.`, del: [`all entities (env: ${env})`] },
    { scope: 'all', t: 'Purge everything', d: `Delete all events, entities and visual snapshots for the ${env} environment.`, del: [`all events + entities (env: ${env})`, 'visual snapshot metadata + image artifacts'] },
  ];

  return (
    <Card className="border-destructive/40 py-0 gap-0 overflow-hidden">
      <div className="px-5 py-3.5 border-b border-destructive/20"><h3 className="serif text-lg text-destructive">Danger zone · {env}</h3></div>
      {result && <div className="m-4 rounded-md border bg-muted/40 px-4 py-3 text-sm">{result}</div>}
      {rows.map((r) => (
        <div key={r.scope} className="flex items-center justify-between gap-4 px-5 py-3.5 border-b last:border-0">
          <div><div className="text-sm">{r.t}</div><div className="text-xs text-muted-foreground mt-0.5">{r.d}</div></div>
          <Button variant="destructive" onClick={() => setAction({ scope: r.scope, title: r.t, del: r.del })}>{r.t}</Button>
        </div>
      ))}
      {action && (
        <DangerConfirm title={`${action.title}?`}
          blastRadius={<>This purges <strong className="text-foreground font-mono">{env}</strong> data only and cannot be undone.</>}
          willDelete={action.del} willKeep={['metric & funnel definitions', 'API keys', 'entity-type schema']}
          matchValue={slug} matchLabel="Type the project slug to confirm" confirmLabel={action.title}
          onCancel={() => setAction(null)}
          onConfirm={async () => { const res = await client!.purgeData(slug, { env, scope: action.scope, confirm_slug: slug }); setResult(`Purged ${env}: ${res.events_deleted} events, ${res.entities_deleted} entities, ${res.snapshots_deleted} visual snapshots removed.`); setAction(null); }} />
      )}
    </Card>
  );
}

function CopyButton({
  value,
  children,
  onCopied,
  onFailed,
  variant = 'outline',
  className,
}: {
  value: string;
  children: React.ReactNode;
  onCopied?: () => void;
  onFailed?: () => void;
  variant?: 'default' | 'outline';
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setFailed(false);
      setCopied(true);
      onCopied?.();
      setTimeout(() => setCopied(false), 1400);
    } catch {
      setFailed(true);
      onFailed?.();
    }
  };

  return (
    <span>
      <Button variant={variant} size="sm" className={cn('h-8', className)} onClick={copy}>
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        {copied ? 'Copied' : children}
      </Button>
      {failed && <span role="alert" className="mt-2 block max-w-xs text-xs text-destructive">Copy blocked. Open the config and select it manually.</span>}
    </span>
  );
}

function CodeBlock({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setFailed(false);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      setFailed(true);
    }
  };
  return (
    <div className="relative">
      <Button variant="outline" size="sm" className="absolute top-2 right-2 h-9 z-10" onClick={copy}>{copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}{copied ? 'Copied' : 'Copy'}</Button>
      <pre className="rounded-md border bg-background p-4 pr-20 text-xs leading-relaxed overflow-auto">{code}</pre>
      {failed && <div role="alert" className="mt-2 text-xs text-destructive">Copy blocked. Select the text manually.</div>}
    </div>
  );
}
