import { useState } from 'react';
import { Check, Copy } from '@/components/icons';
import { useStore, useAsync } from '../store';
import { MCP_CLIENTS, MCP_RUNNER, mcpClientById, mcpServerConfig, type McpClientId, type McpClientLogo } from '../mcpClients';
import { Panel, Loading, DangerConfirm } from '../components/ui';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

const TOOLS = [
  ['Context', ['list_projects', 'get_project_schema']],
  ['Registry', ['register_metric', 'update_metric', 'deprecate_metric', 'explain_metric_usage', 'list_metrics', 'delete_metric', 'register_entity_type', 'define_funnel', 'list_funnels', 'delete_funnel']],
  ['Feature delivery', ['create_feature_flag', 'list_feature_flags', 'update_feature_flag', 'archive_feature_flag', 'evaluate_feature_flag', 'create_experiment', 'list_experiments', 'update_experiment', 'start_experiment', 'conclude_experiment', 'get_experiment_results']],
  ['Queries', ['query_trend', 'query_funnel', 'query_entities', 'query_retention', 'query_lifecycle', 'query_stickiness', 'sample_events']],
  ['Diagnostics', ['list_ingest_warnings', 'list_data_quality_issues']],
  ['Insights', ['list_insights', 'create_insight', 'resolve_insight']],
];

export function Setup() {
  const { client, baseUrl, token, tokenKind, project, env } = useStore();
  const [clientId, setClientId] = useState<McpClientId>('claude-code');
  const publicUrl =
    (import.meta.env.VITE_POOLSTATIS_PUBLIC_URL as string | undefined) ||
    (import.meta.env.VITE_POOLSTATIS_API_URL as string | undefined) ||
    'https://api.poolstatis.com';
  const serverUrl = baseUrl || publicUrl;
  const slug = project ?? 'your-project';
  const std = useAsync(() => client!.standard(), []);
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
    <div className="space-y-4 max-w-4xl">
      <SectionLabel>Connection</SectionLabel>
      <Panel title="Key map">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3.5">
          <KeyUse prefix="sk_" title="Admin console" body="Paste this on the connect screen. It reads and manages one project: registry, Data, Keys, purge." />
          <KeyUse prefix="pk_" title="Product runtime" body="Use this in the SDK or HTTP ingest. It only writes events/entities for one env." />
          <KeyUse prefix="pt_" title="MCP agents" body="Use this in agent config for org-wide project discovery. A project sk_ also works when you want a narrow scope." />
        </div>
        <p className="text-xs text-muted-foreground mt-3.5">After the product sends data, inspect it in <strong className="text-foreground font-normal">Data → Event stream</strong>. Data health shows registered coverage and entity/event consistency; ingest warnings have their own Warnings tab.</p>
      </Panel>
      <Panel title="Connect a coding agent over MCP">
        <p className="text-muted-foreground text-sm mb-3.5">Choose where Poolstatis should appear. The selected card controls the setup guide below; copy the full JSON when the host accepts JSON, or copy command/env separately for form-based settings.</p>
        {MCP_RUNNER.packageStatus !== 'published' && (
          <div className="mb-3.5 break-words rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-xs text-amber-200 [&_code]:break-all">
            MCP runner is not marked published for this deploy. Use the command below for this self-host build. Set <code>VITE_POOLSTATIS_MCP_PACKAGE_PUBLISHED=true</code> only after the public runner package exists.
          </div>
        )}
        <div className="mb-3.5 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {MCP_CLIENTS.map((profile) => (
            <button
              key={profile.id}
              type="button"
              onClick={() => setClientId(profile.id)}
              aria-pressed={clientId === profile.id}
              className={cn(
                'rounded-md border p-3 text-left transition-colors',
                clientId === profile.id
                  ? 'border-primary bg-primary/10 text-foreground'
                  : 'bg-muted/20 text-muted-foreground hover:bg-accent/50 hover:text-foreground',
              )}
            >
              <div className="flex items-start gap-3">
                <McpClientLogoMark logo={profile.logo} className="size-9" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="break-words text-sm font-medium">{profile.name}</span>
                    {profile.badge && <Badge variant="outline" className="text-xs">{profile.badge}</Badge>}
                  </div>
                  <div className="mt-1 text-xs leading-relaxed">{profile.pasteTarget}</div>
                </div>
              </div>
            </button>
          ))}
        </div>
        <div className="mb-3.5 rounded-md border bg-muted/20 p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex items-start gap-3">
              <McpClientLogoMark logo={selectedClient.logo} className="size-11" />
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-base font-medium">{selectedClient.name}</h3>
                  <Badge variant="outline">Selected</Badge>
                </div>
                <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{selectedClient.description}</p>
              </div>
            </div>
            <div className="flex shrink-0 flex-wrap gap-2">
              <CopyButton value={mcpConfig}>Copy JSON</CopyButton>
              <CopyButton value={mcpCommand}>Copy command</CopyButton>
              <CopyButton value={mcpEnv}>Copy env</CopyButton>
            </div>
          </div>
          <ol className="mt-4 grid gap-2 md:grid-cols-3">
            {selectedClient.setupSteps.map((step, index) => (
              <li key={step} className="rounded-md border bg-background p-3">
                <div className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground">
                  <span className="flex size-6 items-center justify-center rounded-full border bg-muted/40 text-foreground">{index + 1}</span>
                  Step {index + 1}
                </div>
                <p className="text-xs leading-relaxed text-muted-foreground">{step}</p>
              </li>
            ))}
          </ol>
        </div>
        {tokenKind === 'user' && (
          <div className="mb-3.5 rounded-md border border-primary/30 bg-primary/5 px-4 py-3 text-xs text-muted-foreground">
            This is a config template. Replace <code>&lt;replace-with-pt-or-sk&gt;</code> with the one-time <code>pt_</code> from onboarding, a newly issued personal token from Keys, or a project <code>sk_</code>.
          </div>
        )}
        <CodeBlock code={mcpConfig} />
        <p className="text-xs text-muted-foreground mt-2.5">{selectedClient.pasteTarget} Use a personal token (<code>pt_</code>) for org-wide discovery, or a project secret key (<code>sk_</code>) for a narrower scope.</p>
      </Panel>
      <Panel title="Send events from your product (HTTP)">
        <p className="text-muted-foreground text-sm mb-3.5">Issue an ingest key (<code>pk_</code>) on the Keys tab — write-only, safe in client code. It encodes the project and env.</p>
        <CodeBlock code={ingestCurl} />
      </Panel>

      <SectionLabel>MCP tools the agent gets</SectionLabel>
      <Panel>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
          {TOOLS.map(([group, tools]) => (
            <div key={group as string} className="min-w-0">
              <div className="text-xs font-medium text-muted-foreground mb-2">{group}</div>
              <div className="flex flex-wrap gap-1.5">{(tools as string[]).map((t) => <Badge key={t} variant="outline" className="max-w-full whitespace-normal break-all font-normal font-mono text-xs">{t}</Badge>)}</div>
            </div>
          ))}
        </div>
        <p className="text-xs text-muted-foreground mt-3.5">Plus resources <code>poolstatis://standard/instrumentation</code> and <code>poolstatis://{slug}/schema</code>.</p>
      </Panel>

      <SectionLabel>The instrumentation standard</SectionLabel>
      <Panel>
        {std.loading ? <Loading /> : <pre className="rounded-md border bg-background p-4 text-xs leading-relaxed overflow-auto max-h-96 whitespace-pre-wrap">{std.error ? `could not load standard: ${std.error}` : std.data}</pre>}
      </Panel>

      <SectionLabel danger>Danger zone</SectionLabel>
      <DangerZone slug={slug} env={env} />
    </div>
  );
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

function SectionLabel({ children, danger }: { children: React.ReactNode; danger?: boolean }) {
  return <div className={`text-xs font-medium pb-2 border-b mt-4 ${danger ? 'text-destructive border-destructive/30' : 'text-muted-foreground'}`}>{children}</div>;
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
    { scope: 'all', t: 'Purge everything', d: `Delete all events AND entities for the ${env} environment.`, del: [`all events + entities (env: ${env})`] },
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
          onConfirm={async () => { const res = await client!.purgeData(slug, { env, scope: action.scope, confirm_slug: slug }); setResult(`Purged ${env}: ${res.events_deleted} events, ${res.entities_deleted} entities removed.`); setAction(null); }} />
      )}
    </Card>
  );
}

function CopyButton({ value, children }: { value: string; children: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      // Clipboard can be blocked by browser policy.
    }
  };

  return (
    <Button variant="outline" size="sm" className="h-8" onClick={copy}>
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      {copied ? 'Copied' : children}
    </Button>
  );
}

function CodeBlock({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => { try { await navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 1400); } catch { /* blocked */ } };
  return (
    <div className="relative">
      <Button variant="outline" size="sm" className="absolute top-2 right-2 h-9 z-10" onClick={copy}>{copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}{copied ? 'Copied' : 'Copy'}</Button>
      <pre className="rounded-md border bg-background p-4 pr-20 text-xs leading-relaxed overflow-auto">{code}</pre>
    </div>
  );
}
