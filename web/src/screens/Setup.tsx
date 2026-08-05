import { useEffect, useState } from 'react';
import { Loader2 } from '@/components/icons';
import { useStore, useAsync } from '../store';
import { MCP_CLIENTS, MCP_RUNNER, mcpClientById, mcpServerConfig, type McpClientId } from '../mcpClients';
import { CopyButton, ProductConnectionGuide } from '../components/ProductConnectionGuide';
import { Panel, Loading, DangerConfirm, ErrorNote } from '../components/ui';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
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

export function Setup() {
  const { client, baseUrl, token, tokenKind, projects, project, env } = useStore();
  const [freshIngestKey, setFreshIngestKey] = useState<string | null>(null);
  const [creatingKey, setCreatingKey] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const publicUrl =
    (import.meta.env.VITE_POOLSTATIS_PUBLIC_URL as string | undefined) ||
    (import.meta.env.VITE_POOLSTATIS_API_URL as string | undefined) ||
    'https://api.poolstatis.xyz';
  const serverUrl = (baseUrl || publicUrl).replace(/\/$/, '');
  const selectedProject = projects.find((item) => item.slug === project);
  const projectName = selectedProject?.name ?? project ?? 'Product';

  const proof = useAsync(
    () => project ? client!.onboardingStatus(project, env) : Promise.resolve(null),
    [project, env],
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

  useEffect(() => {
    if (!project || eventSeen) return;
    const timer = window.setInterval(() => proof.reload(), 5000);
    return () => window.clearInterval(timer);
    // The reload callback is intentionally read from the latest render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventSeen, project]);

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

  if (!project) {
    return <Panel title="Setup"><p className="text-sm text-muted-foreground">Select a project first.</p></Panel>;
  }

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <header>
        <div className="mb-1 text-xs text-muted-foreground">{projectName} · {env}</div>
        <h1 className="serif text-3xl font-normal">Connect your product</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          The setup is complete when Poolstatis receives a real product event. A coding agent can install the SDK, but MCP is optional.
        </p>
      </header>

      <ProductConnectionGuide
        ingestKey={freshIngestKey}
        keyReady={sourceGate?.complete ?? false}
        serverUrl={serverUrl}
        projectName={projectName}
        projectSlug={project}
        eventSeen={eventSeen}
        lastSeen={lastSeen}
        checking={proof.loading}
        creatingKey={creatingKey}
        error={keyError ?? proof.error}
        onCreateKey={() => void createIngestKey()}
        onCheck={proof.reload}
      />

      <OptionalMcp
        serverUrl={serverUrl}
        storedToken={tokenKind === 'personal' || tokenKind === 'secret' ? token : null}
        canIssuePersonalToken={tokenKind === 'user'}
        connected={agentGate?.complete ?? false}
      />

      <details
        className="rounded-md border bg-card"
        onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}
      >
        <summary className="cursor-pointer list-none px-4 py-3.5 outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-medium">Advanced setup and administration</div>
              <p className="mt-1 text-xs text-muted-foreground">HTTP ingest, key types, webhooks, MCP tools, instrumentation standard, and data deletion.</p>
            </div>
            <Badge variant="outline">Advanced</Badge>
          </div>
        </summary>
        <div className="space-y-4 border-t p-4">
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
        </div>
      </details>
    </div>
  );
}

function OptionalMcp({ serverUrl, storedToken, canIssuePersonalToken, connected }: {
  serverUrl: string;
  storedToken: string | null;
  canIssuePersonalToken: boolean;
  connected: boolean;
}) {
  const { client } = useStore();
  const [open, setOpen] = useState(false);
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
    <section className="rounded-md border bg-card">
      <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-medium">Connect analytics tools to your agent</h2>
            <Badge variant={connected ? 'default' : 'outline'}>{connected ? 'Connected' : 'Optional'}</Badge>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">MCP lets an agent query metrics and manage the registry. It is not needed to send product events.</p>
        </div>
        <Button variant="outline" onClick={() => setOpen((value) => !value)}>{open ? 'Hide MCP setup' : connected ? 'View MCP setup' : 'Set up MCP'}</Button>
      </div>

      {open && (
        <div className="space-y-4 border-t p-4">
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
      )}
    </section>
  );
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
