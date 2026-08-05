import { useMemo, useState, type ReactNode } from 'react';
import { Check, Copy, Eye, EyeOff, Loader2 } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

type AgentId = 'codex' | 'claude-code' | 'cursor' | 'other';
type ManualRuntime = 'browser' | 'server';

const SDK_PACKAGE = '@poolstatis/sdk@latest';
const SKILLS_SOURCE = 'https://github.com/lim5max/poolstatis';
const SKILL_NAMES = ['poolstatis-instrument', 'poolstatis-analyze', 'poolstatis-maintain'] as const;

const AGENTS: Array<{ id: AgentId; name: string; skillTarget: string }> = [
  { id: 'codex', name: 'Codex', skillTarget: 'codex' },
  { id: 'claude-code', name: 'Claude Code', skillTarget: 'claude-code' },
  { id: 'cursor', name: 'Cursor', skillTarget: "'*'" },
  { id: 'other', name: 'Other', skillTarget: "'*'" },
];

export interface ProductConnectionGuideProps {
  ingestKey: string | null;
  keyReady?: boolean;
  serverUrl: string;
  projectName: string;
  projectSlug: string;
  goal?: string;
  eventSeen: boolean;
  lastSeen?: string | null;
  checking?: boolean;
  creatingKey?: boolean;
  error?: string | null;
  onCreateKey?: () => void;
  onCheck: () => void;
  onOpenProject?: () => void;
}

export function ProductConnectionGuide({
  ingestKey,
  keyReady,
  serverUrl,
  projectName,
  projectSlug,
  goal,
  eventSeen,
  lastSeen,
  checking = false,
  creatingKey = false,
  error,
  onCreateKey,
  onCheck,
  onOpenProject,
}: ProductConnectionGuideProps) {
  const [method, setMethod] = useState<'agent' | 'manual'>('agent');
  const [agentId, setAgentId] = useState<AgentId>('codex');
  const [manualRuntime, setManualRuntime] = useState<ManualRuntime>('browser');
  const selectedAgent = AGENTS.find((agent) => agent.id === agentId) ?? AGENTS[0]!;
  const hasKey = keyReady ?? Boolean(ingestKey);
  const normalizedServerUrl = serverUrl.replace(/\/$/, '');
  const envName = manualRuntime === 'browser' ? 'VITE_POOLSTATIS_INGEST_KEY' : 'POOLSTATIS_INGEST_KEY';
  const envLine = ingestKey ? `${envName}=${ingestKey}` : '';

  const agentTask = useMemo(() => buildAgentTask({
    agent: selectedAgent,
    goal,
    projectSlug,
    serverUrl: normalizedServerUrl,
  }), [goal, normalizedServerUrl, projectSlug, selectedAgent]);
  const manualCode = useMemo(
    () => buildManualCode(normalizedServerUrl, manualRuntime),
    [manualRuntime, normalizedServerUrl],
  );

  return (
    <div className="space-y-4">
      <div className="grid gap-2 sm:grid-cols-3" aria-label="Connection progress">
        <ProgressStep number={1} complete={hasKey} title="Product key" body={hasKey ? 'Ready' : 'Create one below'} />
        <ProgressStep number={2} complete={eventSeen} active={hasKey && !eventSeen} title="Add Poolstatis" body={eventSeen ? 'Installed' : 'Agent or manual'} />
        <ProgressStep number={3} complete={eventSeen} title="First event" body={eventSeen ? 'Connection works' : 'Waiting for data'} />
      </div>

      {eventSeen && (
        <div className="rounded-md border border-emerald-500/35 bg-emerald-500/5 p-4" aria-live="polite">
          <div className="flex items-start gap-3">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-600">
              <Check className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">{projectName} is connected</div>
              <p className="mt-1 text-xs text-muted-foreground">
                Poolstatis received a real product event{lastSeen ? ` at ${formatTimestamp(lastSeen)}` : ''}. You can add more metrics later.
              </p>
              {onOpenProject && <Button className="mt-3" onClick={onOpenProject}>Open event stream</Button>}
            </div>
          </div>
        </div>
      )}

      <section className="rounded-md border bg-card">
        <div className="border-b px-4 py-3.5">
          <div className="flex items-center gap-2">
            <StepNumber complete={hasKey}>1</StepNumber>
            <h2 className="text-sm font-medium">Create a product key</h2>
          </div>
          <p className="mt-1 pl-8 text-xs text-muted-foreground">This write-only key can send events. It cannot read your analytics or change the project.</p>
        </div>
        <div className="p-4">
          {ingestKey ? (
            <ProductKey keyValue={ingestKey} envName={envName} />
          ) : (
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <div className="text-sm font-medium">{hasKey ? 'A product key already exists' : 'A fresh key is shown only once'}</div>
                <p className="mt-1 text-xs text-muted-foreground">{hasKey ? 'Poolstatis stores only its hash. Create a fresh key if you no longer have the original.' : 'Create one now, then put it in your product environment — never in an AI chat.'}</p>
              </div>
              {onCreateKey && (
                <Button onClick={onCreateKey} disabled={creatingKey}>
                  {creatingKey && <Loader2 className="size-4 animate-spin" />}
                  {creatingKey ? 'Creating…' : hasKey ? 'Create fresh key' : 'Create product key'}
                </Button>
              )}
            </div>
          )}
          {error && <p className="mt-3 text-xs text-destructive">{error}</p>}
        </div>
      </section>

      <section className={cn('rounded-md border bg-card', !hasKey && 'opacity-60')}>
        <div className="border-b px-4 py-3.5">
          <div className="flex items-center gap-2">
            <StepNumber complete={eventSeen}>2</StepNumber>
            <h2 className="text-sm font-medium">Add Poolstatis to your product</h2>
          </div>
          <p className="mt-1 pl-8 text-xs text-muted-foreground">Use your coding agent or install it yourself. MCP is not required.</p>
        </div>
        <div className="p-4">
          <div className="grid gap-2 sm:grid-cols-2" role="group" aria-label="Installation method">
            <MethodButton
              selected={method === 'agent'}
              title="Use a coding agent"
              body="Recommended — the agent inspects your project and runs the right checks."
              badge="Easiest"
              onClick={() => setMethod('agent')}
            />
            <MethodButton
              selected={method === 'manual'}
              title="Install manually"
              body="Use copy-paste commands and a small starter snippet."
              onClick={() => setMethod('manual')}
            />
          </div>

          {method === 'agent' ? (
            <div className="mt-4 space-y-4">
              <div>
                <div className="mb-2 text-xs font-medium text-muted-foreground">Which agent edits your code?</div>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" role="group" aria-label="Coding agent">
                  {AGENTS.map((agent) => (
                    <button
                      key={agent.id}
                      type="button"
                      aria-pressed={agentId === agent.id}
                      onClick={() => setAgentId(agent.id)}
                      className={cn(
                        'h-10 rounded-md border px-3 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50',
                        agentId === agent.id ? 'border-primary bg-primary/5 text-foreground' : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                      )}
                    >
                      {agent.name}
                    </button>
                  ))}
                </div>
              </div>

              <div className="rounded-md border bg-muted/15 p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <div className="text-sm font-medium">Give {selectedAgent.name} one task</div>
                    <p className="mt-1 max-w-xl text-xs leading-relaxed text-muted-foreground">
                      The task installs all three Poolstatis skills, adds the SDK, and verifies the build. It contains no API key.
                    </p>
                  </div>
                  <CopyButton value={agentTask}>Copy task for {selectedAgent.name}</CopyButton>
                </div>
                <ol className="mt-4 grid gap-2 sm:grid-cols-3">
                  <TinyStep number="1" text={`Save the key in your product's local environment.`} />
                  <TinyStep number="2" text={`Paste the copied task into ${selectedAgent.name}.`} />
                  <TinyStep number="3" text="Run the product and trigger the new event." />
                </ol>
              </div>
            </div>
          ) : (
            <div className="mt-4 space-y-4">
              <div className="flex flex-wrap gap-2" role="group" aria-label="Runtime">
                <Button variant={manualRuntime === 'browser' ? 'default' : 'outline'} size="sm" onClick={() => setManualRuntime('browser')}>React / Vite</Button>
                <Button variant={manualRuntime === 'server' ? 'default' : 'outline'} size="sm" onClick={() => setManualRuntime('server')}>Node / server</Button>
              </div>
              <CodeRow label="1. Install the SDK" code={`npm install ${SDK_PACKAGE}`} copyLabel="Copy install command" />
              {ingestKey && <CodeRow label={`2. Add this to .env`} code={envLine} copyLabel="Copy .env line" sensitive />}
              <CodeRow label="3. Initialize and send one real event" code={manualCode} copyLabel="Copy starter code" />
            </div>
          )}
        </div>
      </section>

      <section className="rounded-md border bg-card">
        <div className="p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3">
              <StepNumber complete={eventSeen}>3</StepNumber>
              <div>
                <h2 className="text-sm font-medium">Check the first real event</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Open your product and perform the action you instrumented. Poolstatis checks server data, not copy-button clicks.
                </p>
              </div>
            </div>
            <Button variant={eventSeen ? 'outline' : 'default'} onClick={onCheck} disabled={checking || !hasKey}>
              {checking && <Loader2 className="size-4 animate-spin" />}
              {checking ? 'Checking…' : eventSeen ? 'Check again' : 'Check connection'}
            </Button>
          </div>
          {!eventSeen && hasKey && (
            <div className="mt-3 flex items-center gap-2 rounded-md bg-muted/30 px-3 py-2 text-xs text-muted-foreground" aria-live="polite">
              <span className="size-2 animate-pulse rounded-full bg-amber-500" /> Waiting for the first event from {projectName}…
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function buildAgentTask({
  agent,
  goal,
  projectSlug,
  serverUrl,
}: {
  agent: { name: string; skillTarget: string };
  goal?: string;
  projectSlug: string;
  serverUrl: string;
}): string {
  const skills = SKILL_NAMES.join(' ');
  return `Set up Poolstatis analytics in this repository.

Security rule: never ask me to paste a pk_, sk_, or pt_ token into chat. Read the product write key from the local environment. If it is missing, stop and tell me which local .env or hosting setting I should update.

1. Inspect the repository and identify its framework, runtime, package manager, and existing analytics conventions.
2. Install the Poolstatis workflows before editing code:
   pnpm dlx skills add ${SKILLS_SOURCE} --skill ${skills} --agent ${agent.skillTarget} -y
3. Follow poolstatis-instrument. Install ${SDK_PACKAGE} and initialize it with:
   - URL: ${serverUrl}
   - write key: read from the product environment; do not hardcode or print it
   - project: ${projectSlug}
4. Instrument one real, meaningful product action first${goal ? ` for this goal: ${goal}` : ''}. Use a stable user/account id; never use a fresh random or session id as distinct_id.
5. Do not send raw URLs, query strings, DOM/text, form values, credentials, or unrestricted properties.
6. Run the relevant typecheck, tests, and build. Fix only issues caused by this change.
7. Report the exact files changed and tell me the single product action to perform so Poolstatis receives its first event.

MCP is optional for this setup. Do not block SDK installation on MCP configuration.`;
}

function buildManualCode(serverUrl: string, runtime: ManualRuntime): string {
  const keyExpression = runtime === 'browser'
    ? 'import.meta.env.VITE_POOLSTATIS_INGEST_KEY'
    : 'process.env.POOLSTATIS_INGEST_KEY!';
  return `import { createClient } from '@poolstatis/sdk';

const analytics = createClient({
  url: '${serverUrl}',
  ingestKey: ${keyExpression},
});

// Replace this with one real product action and a stable user id.
analytics.track('signup.completed', user.id);`;
}

function ProductKey({ keyValue, envName }: { keyValue: string; envName: string }) {
  const [revealed, setRevealed] = useState(false);
  const envLine = `${envName}=${keyValue}`;
  return (
    <div className="rounded-md border bg-muted/15 p-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-medium">
            Product key ready
            <Badge variant="outline" className="font-mono text-xs">pk_ write only</Badge>
          </div>
          <code className="mt-1 block max-w-full truncate text-xs text-muted-foreground">
            {revealed ? envLine : `${envName}=pk_••••••••••••`}
          </code>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button variant="ghost" size="sm" onClick={() => setRevealed((value) => !value)}>
            {revealed ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
            {revealed ? 'Hide' : 'Reveal'}
          </Button>
          <CopyButton value={envLine}>Copy .env line</CopyButton>
        </div>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">Paste this into the product's environment, not into Codex, Claude, Cursor, or another chat.</p>
    </div>
  );
}

function ProgressStep({ number, complete, active, title, body }: { number: number; complete: boolean; active?: boolean; title: string; body: string }) {
  return (
    <div className={cn('rounded-md border p-3', complete ? 'border-emerald-500/35 bg-emerald-500/5' : active ? 'border-primary/40 bg-primary/5' : 'bg-muted/15')}>
      <div className="flex items-center gap-2">
        <StepNumber complete={complete}>{number}</StepNumber>
        <div className="text-sm font-medium">{title}</div>
      </div>
      <div className="mt-1 pl-8 text-xs text-muted-foreground">{body}</div>
    </div>
  );
}

function StepNumber({ complete, children }: { complete: boolean; children: ReactNode }) {
  return (
    <span className={cn('flex size-6 shrink-0 items-center justify-center rounded-full border text-xs', complete ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600' : 'bg-background text-muted-foreground')}>
      {complete ? <Check className="size-3.5" /> : children}
    </span>
  );
}

function MethodButton({ selected, title, body, badge, onClick }: { selected: boolean; title: string; body: string; badge?: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cn('rounded-md border p-3 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50', selected ? 'border-primary bg-primary/5' : 'bg-muted/15 hover:bg-accent/40')}
    >
      <span className="flex items-center justify-between gap-2 text-sm font-medium">
        {title}
        {badge && <Badge>{badge}</Badge>}
      </span>
      <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">{body}</span>
    </button>
  );
}

function TinyStep({ number, text }: { number: string; text: string }) {
  return (
    <li className="flex gap-2 rounded-md border bg-background p-3 text-xs leading-relaxed text-muted-foreground">
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full border text-foreground">{number}</span>
      <span>{text}</span>
    </li>
  );
}

function CodeRow({ label, code, copyLabel, sensitive }: { label: string; code: string; copyLabel: string; sensitive?: boolean }) {
  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="text-xs font-medium text-muted-foreground">{label}</div>
        <CopyButton value={code}>{copyLabel}</CopyButton>
      </div>
      <pre className={cn('overflow-auto rounded-md border bg-background p-4 text-xs leading-relaxed', sensitive && 'select-none')}>{sensitive ? code.replace(/=pk_.+$/, '=pk_••••••••••••') : code}</pre>
      {sensitive && <p className="mt-1.5 text-xs text-muted-foreground">The copy button includes the full value. Paste it only into .env.</p>}
    </div>
  );
}

export function CopyButton({ value, children }: { value: string; children: ReactNode }) {
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
    <Button variant="outline" size="sm" onClick={copy}>
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      {copied ? 'Copied' : children}
    </Button>
  );
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
