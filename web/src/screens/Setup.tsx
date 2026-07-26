import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, Copy } from '@/components/icons';
import { useStore, useAsync } from '../store';
import { MCP_CLIENTS, MCP_RUNNER, mcpClientById, mcpServerConfig, type McpClientId, type McpClientLogo } from '../mcpClients';
import { Panel, Loading, DangerConfirm, ErrorNote, RecoverableError } from '../components/ui';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import type { OnboardingGateKey } from '../api/types';

const TOOLS = [
  ['Context', ['list_projects', 'get_project_schema', 'get_onboarding_status']],
  ['Measurement trust', ['create_actor_link', 'list_actor_links', 'revoke_actor_link', 'register_property', 'list_properties', 'update_property']],
  ['External sources', ['configure_posthog', 'verify_posthog', 'get_posthog_schema']],
  ['Decision loop', ['validate_measurement_contracts', 'diff_measurement_contracts', 'apply_measurement_contracts', 'export_measurement_contracts', 'register_release', 'list_releases', 'get_release', 'evaluate_release', 'list_decisions', 'get_decision', 'approve_decision', 'reject_decision', 'edit_decision', 'explain_outcome', 'prepare_action', 'approve_action', 'get_decision_inbox', 'search_decision_history', 'find_similar_changes']],
  ['Delivery', ['configure_webhook', 'verify_webhook']],
  ['Registry', ['register_metric', 'update_metric', 'deprecate_metric', 'explain_metric_usage', 'list_metrics', 'delete_metric', 'register_entity_type', 'define_funnel', 'list_funnels', 'delete_funnel']],
  ['Feature delivery', ['create_feature_flag', 'list_feature_flags', 'update_feature_flag', 'archive_feature_flag', 'evaluate_feature_flag', 'create_experiment', 'list_experiments', 'update_experiment', 'start_experiment', 'conclude_experiment', 'get_experiment_results']],
  ['Queries', ['query_trend', 'query_funnel', 'query_entities', 'query_retention', 'query_lifecycle', 'query_stickiness', 'sample_events']],
  ['Diagnostics', ['list_ingest_warnings', 'list_data_quality_issues']],
  ['Insights', ['list_insights', 'create_insight', 'resolve_insight']],
];

export function Setup() {
  const { client, baseUrl, token, tokenKind, project, env } = useStore();
  const [clientId, setClientId] = useState<McpClientId>('claude-code');
  const [configCopied, setConfigCopied] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const publicUrl =
    (import.meta.env.VITE_POOLSTATIS_PUBLIC_URL as string | undefined) ||
    (import.meta.env.VITE_POOLSTATIS_API_URL as string | undefined) ||
    'https://api.poolstatis.com';
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

  const mcpToken = tokenKind === 'user' ? '<replace-with-pt-or-sk>' : token;
  const normalizedServerUrl = serverUrl.replace(/\/$/, '');
  const mcpConfig = mcpServerConfig(MCP_RUNNER.command, MCP_RUNNER.args, normalizedServerUrl, mcpToken);
  const mcpCommand = [MCP_RUNNER.command, ...MCP_RUNNER.args].join(' ');
  const mcpEnv = `POOLSTATIS_URL=${normalizedServerUrl}\nPOOLSTATIS_TOKEN=${mcpToken}`;
  const ingestCurl = `curl -X POST ${serverUrl}/i/v1/events \\
  -H 'Authorization: Bearer pk_…' \\
  -H 'content-type: application/json' \\
  -d '{"events":[{"event":"signup.completed","distinct_id":"u_123","properties":{"plan":"pro"}}]}'`;

  return (
    <div className="max-w-5xl space-y-5">
      <header className="max-w-2xl">
        <h1 className="serif text-3xl tracking-tight text-balance">Connect Poolstatis in four steps</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          Add one MCP config, call a tool through your client, then verify data and a query. Poolstatis only marks work complete from server evidence.
        </p>
      </header>

      <Panel
        title="Verified progress"
        right={<div className="flex items-center gap-2">
          <Badge variant="outline">server evidence</Badge>
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
                ? <ProofSummary gates={proof.data.gates} />
                : null}
      </Panel>

      <Panel title="1. Choose your MCP client">
        <label className="block max-w-sm text-xs font-medium text-muted-foreground" htmlFor="mcp-client">
          Client
        </label>
        <select
          id="mcp-client"
          value={clientId}
          onChange={(event) => setClientId(event.target.value as McpClientId)}
          className="mt-2 h-10 w-full max-w-sm rounded-md border bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          {MCP_CLIENTS.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
        </select>
        <div className="mt-4 flex items-start gap-3 rounded-md bg-muted/35 p-4">
          <McpClientLogoMark logo={selectedClient.logo} className="size-10" />
          <div>
            <div className="text-sm font-medium">{selectedClient.name}</div>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{selectedClient.pasteTarget}</p>
          </div>
        </div>
      </Panel>

      <Panel title="2. Add the config">
        <p className="mb-4 max-w-2xl text-sm text-muted-foreground">
          Copy the config into {selectedClient.name}, then reload the client. A copied config is not proof that MCP ran.
        </p>
        {MCP_RUNNER.packageStatus !== 'published' && (
          <div className="mb-4 break-words rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-xs text-amber-950 dark:text-amber-100 [&_code]:break-all">
            Registry install is disabled for this deploy. The config below uses the exact local Core runner; replace <code>&lt;path-to-poolstatis-core&gt;</code> with its checkout path. Set <code>VITE_POOLSTATIS_MCP_PACKAGE_PUBLISHED=true</code> only after the pinned public package is verified.
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <CopyButton value={mcpConfig} onCopied={() => setConfigCopied(true)} onFailed={() => setConfigOpen(true)}>Copy MCP config</CopyButton>
          <CopyButton value={mcpCommand} onFailed={() => setConfigOpen(true)}>Copy command</CopyButton>
          <CopyButton value={mcpEnv} onFailed={() => setConfigOpen(true)}>Copy environment</CopyButton>
        </div>
        <div aria-live="polite" role="status" className="mt-3 min-h-5 text-xs text-muted-foreground">
          {configCopied ? 'Config copied. This action does not verify MCP use.' : 'No server evidence changes until an MCP-marked request reaches the server.'}
        </div>
        {tokenKind === 'user' && (
          <div className="mt-4 rounded-md border border-primary/30 bg-primary/5 px-4 py-3 text-xs text-muted-foreground">
            Replace <code>&lt;replace-with-pt-or-sk&gt;</code> with a personal <code>pt_</code> token or project <code>sk_</code> key.
          </div>
        )}
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

      <Panel title="3. Record MCP use">
        <p className="text-sm text-muted-foreground">
          Ask the agent to call <code>get_onboarding_status</code> for <code>{slug}</code>, then refresh the proof above. Poolstatis records a request marked by the MCP client and its time. This is last-use evidence, not a heartbeat or transport attestation.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={proof.reload} disabled={proof.loading}>Refresh server proof</Button>
          <Button asChild variant="ghost" size="sm"><Link to="/keys">Review MCP tokens</Link></Button>
        </div>
      </Panel>

      <Panel title="4. Send data and run a query">
        <p className="text-sm text-muted-foreground">
          Send one real product event with a <code>pk_</code> key. Activate its metric in Registry, then run a typed trend or funnel query.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button asChild size="sm"><Link to="/data">Inspect accepted data</Link></Button>
          <Button asChild variant="outline" size="sm"><Link to="/registry">Review metrics</Link></Button>
          <Button asChild variant="ghost" size="sm"><Link to="/measurement">Check measurement trust</Link></Button>
        </div>
      </Panel>

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
              {TOOLS.map(([group, tools]) => (
                <div key={group as string} className="min-w-0">
                  <div className="mb-2 text-xs font-medium text-muted-foreground">{group}</div>
                  <div className="flex flex-wrap gap-1.5">{(tools as string[]).map((tool) => <Badge key={tool} variant="outline" className="max-w-full whitespace-normal break-all font-mono text-xs font-normal">{tool}</Badge>)}</div>
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

function ProofSummary({ gates }: { gates: Array<{ key: OnboardingGateKey; complete: boolean; evidence: Record<string, unknown>; blocker: string | null; next_action: string | null }> }) {
  const byKey = new Map(gates.map((gate) => [gate.key, gate]));
  const project = byKey.get('workspace_created');
  const source = byKey.get('data_source_connected');
  const event = byKey.get('first_event_observed');
  const query = byKey.get('first_query_produced');
  const agent = byKey.get('agent_connected');
  const statuses = [
    {
      label: 'Project created',
      complete: Boolean(project?.complete),
      detail: project?.complete ? String(project.evidence.project ?? 'Verified by the server') : 'No project exists in this scope.',
    },
    {
      label: source?.evidence.native ? 'Ingest key created' : 'Data source verified',
      complete: Boolean(source?.complete),
      detail: source?.complete
        ? source.evidence.native
          ? `Active pk_ key · ${formatEvidenceTime(source.evidence.native_key_created_at)}`
          : `Verified external source · ${formatEvidenceTime(source.evidence.posthog_verified_at)}`
        : source?.blocker ?? 'No ingest key or verified source.',
    },
    {
      label: event?.evidence.observation_source === 'posthog' ? 'External observation verified' : 'First accepted event',
      complete: Boolean(event?.complete),
      detail: event?.complete
        ? event.evidence.observation_source === 'posthog'
          ? `PostHog query · ${formatEvidenceTime(event.evidence.posthog_query_at)}`
          : `${Number(event.evidence.native_events ?? 0).toLocaleString()} accepted · ${formatEvidenceTime(event.evidence.last_seen)}`
        : event?.blocker ?? 'No accepted event yet.',
    },
    {
      label: 'First query completed',
      complete: Boolean(query?.complete),
      detail: query?.complete
        ? `${String(query.evidence.source ?? 'native')} · ${formatEvidenceTime(query.evidence.created_at)}`
        : query?.blocker ?? 'No typed query result yet.',
    },
    {
      label: 'MCP request last recorded',
      complete: Boolean(agent?.complete),
      detail: agent?.complete
        ? `${String(agent.evidence.client ?? 'MCP client')} · ${formatEvidenceTime(agent.evidence.observed_at)}`
        : 'Not recorded — no MCP-marked request.',
    },
  ];
  return (
    <div className="grid gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-2 xl:grid-cols-5" aria-live="polite">
      {statuses.map((status) => (
        <div key={status.label} className="min-w-0 bg-card p-4">
          <div className="flex items-center gap-2 text-sm font-medium">
            <span className={cn('size-2 shrink-0 rounded-full', status.complete ? 'bg-emerald-500' : 'bg-amber-500')} aria-hidden="true" />
            {status.label}
          </div>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{status.detail}</p>
        </div>
      ))}
    </div>
  );
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

const MCP_LOGO_META: Record<McpClientLogo, { color: string; label: string }> = {
  claude: { color: 'var(--cat-referral)', label: 'Claude' },
  codex: { color: 'var(--foreground)', label: 'Codex' },
  cursor: { color: 'var(--cat-quality)', label: 'Cursor' },
  warp: { color: 'var(--cat-acquisition)', label: 'Warp' },
  windsurf: { color: 'var(--cat-activation)', label: 'Windsurf' },
  vscode: { color: 'var(--cat-acquisition)', label: 'VS Code' },
  cline: { color: 'var(--cat-retention)', label: 'Cline' },
  zed: { color: 'var(--foreground)', label: 'Zed' },
  continue: { color: 'var(--cat-activation)', label: 'Continue' },
  replit: { color: 'var(--cat-referral)', label: 'Replit' },
  opencode: { color: 'var(--cat-quality)', label: 'OpenCode' },
  hermes: { color: 'var(--cat-revenue)', label: 'Hermes' },
  custom: { color: 'var(--muted-foreground)', label: 'Custom MCP' },
};

function McpClientLogoMark({ logo, className }: { logo: McpClientLogo; className?: string }) {
  const meta = MCP_LOGO_META[logo];
  return (
    <span
      aria-label={`${meta.label} logo`}
      className={cn('flex shrink-0 items-center justify-center rounded-md border bg-background', className)}
      style={{ color: meta.color }}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true" className="size-5">
        <McpLogoPath logo={logo} />
      </svg>
    </span>
  );
}

function McpLogoPath({ logo }: { logo: McpClientLogo }) {
  switch (logo) {
    case 'claude':
      return (
        <>
          <circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" strokeWidth="2" />
          <path d="M12 5v14M5 12h14M7.2 7.2l9.6 9.6M16.8 7.2l-9.6 9.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </>
      );
    case 'codex':
      return <path d="M7 7.5 12 4l5 3.5v9L12 20l-5-3.5v-9Zm2 1.1v6.8l3 2.1 3-2.1V8.6l-3-2.1-3 2.1Zm2 1.6 1-0.7 1 0.7v3.6l-1 0.7-1-0.7v-3.6Z" fill="currentColor" />;
    case 'cursor':
      return <path d="M5 3.8 19.2 11 13.4 13.2 10.9 19.4 5 3.8Zm4.1 5.1 2.1 5.5 1-2.5 2.4-0.9-5.5-2.1Z" fill="currentColor" />;
    case 'warp':
      return (
        <>
          <path d="M4 8.5c2.4-2 4.8-2 7.2 0s4.8 2 7.2 0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          <path d="M5.5 13c2-1.6 4-1.6 6 0s4 1.6 6 0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          <path d="M7 17c1.5-1 3-1 4.5 0s3 1 4.5 0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </>
      );
    case 'windsurf':
      return <path d="M7 19h10M8 16c2.5-1.2 5.5-1.2 8 0M8 4v10l8-3.2L8 4Zm2 3.6 2.8 2.2L10 11V7.6Z" fill="currentColor" />;
    case 'vscode':
      return <path d="M19 4.5v15l-4.2-1.8-5.2-4.2-3.1 3L4 15.1 7.9 12 4 8.9l2.5-1.4 3.1 3 5.2-4.2L19 4.5Zm-4 5-3.7 2.5L15 14.5v-5Z" fill="currentColor" />;
    case 'cline':
      return (
        <>
          <path d="m5 7 4 5-4 5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M11 17h8" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
        </>
      );
    case 'zed':
      return <text x="12" y="16.5" textAnchor="middle" fontSize="13" fontWeight="700" fontFamily="var(--font-mono)" fill="currentColor">Z</text>;
    case 'continue':
      return <path d="M6 8.5h7.5a3.5 3.5 0 1 1 0 7H8.8l2.1 2.1-1.4 1.4L5 14.5 9.5 10l1.4 1.4-2.1 2.1h4.7a1.5 1.5 0 0 0 0-3H6v-2Z" fill="currentColor" />;
    case 'replit':
      return (
        <>
          <path d="M9 3h6v6H9V3ZM3 9h6v6H3V9ZM9 15h6v6H9v-6ZM15 9h6v6h-6V9Z" fill="currentColor" />
        </>
      );
    case 'opencode':
      return (
        <>
          <path d="M8.5 6 4 12l4.5 6M15.5 6 20 12l-4.5 6" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" />
          <path d="m13.5 5-3 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </>
      );
    case 'hermes':
      return (
        <>
          <path d="M6 14.5c3.2-6.1 6.8-8.4 12-8.5-1.2 5.2-3.6 8.8-8.5 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M8 8.5H4.5M11 6.2H7.5M15 6h-2.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </>
      );
    case 'custom':
      return (
        <>
          <circle cx="7" cy="8" r="2.2" fill="currentColor" />
          <circle cx="17" cy="8" r="2.2" fill="currentColor" />
          <circle cx="12" cy="17" r="2.2" fill="currentColor" />
          <path d="M8.8 9.4 11 15M15.2 9.4 13 15M9.4 8h5.2" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </>
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

function CopyButton({ value, children, onCopied, onFailed }: { value: string; children: React.ReactNode; onCopied?: () => void; onFailed?: () => void }) {
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
      <Button variant="outline" size="sm" className="h-8" onClick={copy}>
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
