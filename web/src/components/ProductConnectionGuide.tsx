import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Check, Copy, Loader2 } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { CodexLogo } from '@/components/logos/codex';
import { ClaudeCodeLogo } from '@/components/logos/claude-code';
import { CursorLogo } from '@/components/logos/cursor';
import { cn } from '@/lib/utils';

export type AgentId = 'codex' | 'claude-code' | 'cursor' | 'other';
type ProjectMode = 'website' | 'product' | 'both';
type ManualRuntime = 'browser' | 'server';

export interface SetupTaskResponse {
  task: string;
  source: 'deterministic' | 'llm' | 'fallback';
  blocker?: string | null;
  plan?: {
    release_manifest?: { sdk?: string };
    smoke_action?: string;
  } | unknown;
}

const DEFAULT_SDK_PACKAGE = '@poolstatis/sdk@0.3.0';

const AGENTS: Array<{ id: AgentId; name: string }> = [
  { id: 'codex', name: 'Codex' },
  { id: 'claude-code', name: 'Claude Code' },
  { id: 'cursor', name: 'Cursor' },
  { id: 'other', name: 'Other' },
];

export interface ProductConnectionGuideProps {
  ingestKey: string | null;
  keyReady?: boolean;
  serverUrl: string;
  projectName: string;
  projectSlug: string;
  projectMode?: ProjectMode;
  eventSeen: boolean;
  lastSeen?: string | null;
  eventName?: string | null;
  eventEnvironment?: string | null;
  eventRegistered?: boolean | null;
  checking?: boolean;
  creatingKey?: boolean;
  error?: string | null;
  onCreateKey?: () => void;
  getSetupTask?: (agentId: AgentId) => Promise<SetupTaskResponse>;
  onCheck: () => void;
  onOpenProject?: () => void;
  onReviewMetrics?: () => void;
  onConnectMcp?: () => void;
}

export function ProductConnectionGuide({
  ingestKey,
  keyReady,
  serverUrl,
  projectName,
  projectSlug,
  projectMode = 'product',
  eventSeen,
  lastSeen,
  eventName,
  eventEnvironment = 'prod',
  eventRegistered,
  checking = false,
  creatingKey = false,
  error,
  onCreateKey,
  getSetupTask,
  onCheck,
  onOpenProject,
  onReviewMetrics,
  onConnectMcp,
}: ProductConnectionGuideProps) {
  const hasKey = keyReady ?? Boolean(ingestKey);
  const [keySaved, setKeySaved] = useState(!ingestKey && hasKey);
  const [agentId, setAgentId] = useState<AgentId>('codex');
  const [taskCopied, setTaskCopied] = useState(false);
  const [taskResponse, setTaskResponse] = useState<SetupTaskResponse | null>(null);
  const [taskLoading, setTaskLoading] = useState(false);
  const [taskError, setTaskError] = useState<string | null>(null);
  const [taskRequestNonce, setTaskRequestNonce] = useState(0);
  const [manualRuntime, setManualRuntime] = useState<ManualRuntime>('browser');
  const selectedAgent = AGENTS.find((agent) => agent.id === agentId) ?? AGENTS[0]!;
  const normalizedServerUrl = serverUrl.replace(/\/$/, '');
  const envName = 'VITE_POOLSTATIS_INGEST_KEY';
  const envLine = ingestKey ? `${envName}=${ingestKey}` : '';
  const taskUnsafe = taskResponse ? containsCredentialValue(taskResponse.task) : false;
  const plan = taskResponse?.plan && typeof taskResponse.plan === 'object'
    ? taskResponse.plan as { release_manifest?: { sdk?: string }; smoke_action?: string }
    : null;
  const sdkPackage = plan?.release_manifest?.sdk ?? DEFAULT_SDK_PACKAGE;

  useEffect(() => {
    if (eventSeen || !hasKey || (ingestKey && !keySaved) || taskCopied || taskResponse || !getSetupTask) return;
    let active = true;
    setTaskLoading(true);
    setTaskError(null);
    setTaskResponse(null);
    getSetupTask(agentId)
      .then((response) => {
        if (active) setTaskResponse(response);
      })
      .catch((caught) => {
        if (active) setTaskError(caught instanceof Error ? caught.message : 'Could not prepare the setup task.');
      })
      .finally(() => {
        if (active) setTaskLoading(false);
      });
    return () => { active = false; };
  }, [agentId, eventSeen, getSetupTask, hasKey, ingestKey, keySaved, projectSlug, taskCopied, taskRequestNonce, taskResponse]);

  const manualCode = useMemo(
    () => buildManualCode(normalizedServerUrl, manualRuntime),
    [manualRuntime, normalizedServerUrl],
  );

  if (eventSeen) {
    const successCopy = projectMode === 'website'
      ? 'Your first data is here. Open your website overview.'
      : projectMode === 'product'
        ? 'Your first product event is here. Review your activation setup.'
        : 'Your first data is here. Open your project overview.';
    const successAction = projectMode === 'website'
      ? 'Open website overview'
      : projectMode === 'product'
        ? 'Review activation setup'
        : 'Open project overview';

    return (
      <div className="space-y-4">
        <ProgressLine current={3} complete />
        <section className="rounded-lg border border-emerald-500/35 bg-emerald-500/5 p-4 sm:p-5" aria-live="polite">
          <div className="flex items-start gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-700 dark:text-emerald-400">
              <Check className="size-4" aria-hidden="true" />
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="text-lg font-semibold">Event received</h2>
              <p className="mt-1 text-sm text-muted-foreground">{successCopy}</p>
              <dl className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
                {eventName && <div className="flex gap-1"><dt>Event</dt><dd className="font-mono text-foreground">{eventName}</dd></div>}
                <div className="flex gap-1"><dt>Environment</dt><dd className="font-mono text-foreground">{eventEnvironment}</dd></div>
                {lastSeen && <div className="flex gap-1"><dt>Received</dt><dd className="text-foreground">{formatTimestamp(lastSeen)}</dd></div>}
              </dl>
              {eventRegistered === false && (
                <div className="mt-3 rounded-md border border-amber-500/35 bg-amber-500/5 p-3">
                  <div className="text-sm font-medium">Needs attention</div>
                  <p className="mt-1 text-xs text-muted-foreground">The event arrived, but it is not registered yet. Review its purpose before using it in answers.</p>
                  {onReviewMetrics && <Button className="mt-3" size="sm" variant="outline" onClick={onReviewMetrics}>Review proposed metrics</Button>}
                </div>
              )}
              {onOpenProject && <Button className="mt-4" onClick={onOpenProject}>{successAction}</Button>}
            </div>
          </div>
        </section>

        {onConnectMcp && (
          <section className="rounded-lg border bg-card p-4" id="agent-access">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-medium">Let your agent answer questions</h2>
                  <Badge variant="outline">Optional</Badge>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">Connect MCP so your agent can read analytics and manage Poolstatis.</p>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" onClick={onConnectMcp}>Connect agent</Button>
                {onOpenProject && <Button variant="ghost" onClick={onOpenProject}>Not now</Button>}
              </div>
            </div>
          </section>
        )}
      </div>
    );
  }

  if (!hasKey || (ingestKey && !keySaved)) {
    return (
      <div className="space-y-4">
        <ProgressLine current={1} />
        <section className="rounded-lg border bg-card p-4 sm:p-5" aria-labelledby="key-title">
          <h2 id="key-title" className="text-lg font-semibold">Product key ready</h2>
          {ingestKey ? (
            <>
              <div className="mt-4 rounded-md border bg-muted/15 p-3">
                <code className="block max-w-full truncate text-xs text-muted-foreground">{envName}=pk_••••••••••••</code>
              </div>
              <p className="mt-3 text-sm text-muted-foreground">Save this line to your local .env. Never paste the key into an AI chat.</p>
              <div className="mt-4">
                <CopyButton
                  value={envLine}
                  showFallback
                  onCopied={() => setKeySaved(true)}
                  manualConfirmLabel="I saved it"
                >
                  Copy .env line
                </CopyButton>
              </div>
            </>
          ) : (
            <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <div className="text-sm font-medium">Create a fresh write-only key</div>
                <p className="mt-1 text-xs text-muted-foreground">Poolstatis shows the value once, then stores only its hash.</p>
              </div>
              {onCreateKey && (
                <Button onClick={onCreateKey} disabled={creatingKey}>
                  {creatingKey && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
                  {creatingKey ? 'Creating…' : 'Create product key'}
                </Button>
              )}
            </div>
          )}
          {error && <p role="alert" className="mt-3 text-xs text-destructive">{error}</p>}
        </section>
      </div>
    );
  }

  if (!taskCopied) {
    return (
      <div className="space-y-4">
        <ProgressLine current={2} />
        <section className="rounded-lg border bg-card p-4 sm:p-5" aria-labelledby="agent-title">
          <h2 id="agent-title" className="text-lg font-semibold">Which agent edits your code?</h2>
          <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4" role="radiogroup" aria-labelledby="agent-title">
            {AGENTS.map((agent) => (
              <label
                key={agent.id}
                className={cn(
                  'flex min-h-12 cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-left text-sm outline-none transition-colors has-focus-visible:ring-2 has-focus-visible:ring-ring/50',
                  agentId === agent.id ? 'border-primary bg-primary/5 text-foreground' : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground',
                )}
              >
                <input
                  type="radio"
                  className="sr-only"
                  name="coding-agent"
                  value={agent.id}
                  checked={agentId === agent.id}
                  onChange={() => {
                    setAgentId(agent.id);
                    setTaskResponse(null);
                    setTaskError(null);
                  }}
                />
                <AgentMark agentId={agent.id} />
                <span>{agent.name}</span>
              </label>
            ))}
          </div>

          <div className="mt-5 border-t pt-4">
            <p className="max-w-xl text-sm text-muted-foreground">
              Copy this task into {selectedAgent.name}. It will add Poolstatis, instrument your goals, and verify the build.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <CopyButton
                value={taskResponse?.task ?? ''}
                showFallback
                disabled={!taskResponse || taskLoading || taskUnsafe}
                onCopied={() => setTaskCopied(true)}
                manualConfirmLabel="I copied it"
              >
                {taskLoading ? 'Preparing task…' : 'Copy setup task'}
              </CopyButton>
              {taskResponse && <Badge variant="outline">{taskResponse.source === 'llm' ? 'Tailored plan' : 'Verified template'}</Badge>}
            </div>
            {taskLoading && <p className="mt-2 text-xs text-muted-foreground" aria-live="polite">Preparing a secret-free task from your saved goals…</p>}
            {taskUnsafe && <p role="alert" className="mt-2 text-xs text-destructive">Task generation was blocked because it contained credential-like text.</p>}
            {(taskError || error) && (
              <div role="alert" className="mt-3 rounded-md border border-destructive/35 bg-destructive/5 p-3">
                <div className="text-sm font-medium">Could not prepare the setup task</div>
                <p className="mt-1 text-xs text-muted-foreground">{taskError ?? error}</p>
                <Button
                  className="mt-3"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setTaskError(null);
                    setTaskResponse(null);
                    setTaskRequestNonce((value) => value + 1);
                  }}
                >
                  Try again
                </Button>
              </div>
            )}
          </div>

          <ManualInstall
            ingestKeySaved
            runtime={manualRuntime}
            onRuntimeChange={setManualRuntime}
            sdkPackage={sdkPackage}
            code={manualCode}
          />
        </section>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <ProgressLine current={3} />
      <section className="rounded-lg border bg-card p-4 sm:p-5" aria-labelledby="waiting-title">
        <div className="flex items-start gap-3">
          <span className="mt-1 size-2.5 shrink-0 animate-pulse rounded-full bg-primary motion-reduce:animate-none" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <h2 id="waiting-title" className="text-lg font-semibold">Waiting for your first event…</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Run {projectName} and perform the action your agent asked you to test. This status updates from server data.
            </p>
            {plan?.smoke_action && <p className="mt-3 text-xs text-muted-foreground">Try now: <span className="text-foreground">{plan.smoke_action}</span></p>}
            <Button className="mt-4" variant="outline" onClick={onCheck} disabled={checking}>
              {checking && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
              {checking ? 'Checking…' : 'Check now'}
            </Button>
            {error && <p role="alert" className="mt-3 text-xs text-destructive">{error}</p>}
          </div>
        </div>
      </section>
    </div>
  );
}

function ProgressLine({ current, complete = false }: { current: 1 | 2 | 3; complete?: boolean }) {
  const steps = ['Product key', 'Agent task', 'First event'];
  return (
    <ol className="flex items-center gap-2 text-xs text-muted-foreground" aria-label="Connection progress">
      {steps.map((step, index) => {
        const stepNumber = index + 1;
        const done = complete || stepNumber < current;
        const active = stepNumber === current;
        return (
          <li key={step} className={cn('flex min-w-0 items-center gap-2', index < steps.length - 1 && 'flex-1')}>
            <span className={cn(
              'flex size-5 shrink-0 items-center justify-center rounded-full border text-xs',
              done ? 'border-primary bg-primary text-primary-foreground' : active ? 'border-primary text-foreground' : 'bg-background',
            )}>
              {done ? <Check className="size-3" aria-hidden="true" /> : stepNumber}
            </span>
            <span className={cn('truncate', active && 'font-medium text-foreground')}>{step}</span>
            {index < steps.length - 1 && <span className="h-px min-w-3 flex-1 bg-border" aria-hidden="true" />}
          </li>
        );
      })}
    </ol>
  );
}

function AgentMark({ agentId }: { agentId: AgentId }) {
  if (agentId === 'codex') return <span aria-hidden="true"><CodexLogo className="size-5 shrink-0" variant="icon" /></span>;
  if (agentId === 'claude-code') return <span aria-hidden="true"><ClaudeCodeLogo className="size-5 shrink-0" variant="icon" /></span>;
  if (agentId === 'cursor') return <span aria-hidden="true"><CursorLogo className="size-5 shrink-0" /></span>;
  return <span className="flex size-5 shrink-0 items-center justify-center font-mono text-xs" aria-hidden="true">›_</span>;
}

function ManualInstall({
  runtime,
  onRuntimeChange,
  sdkPackage,
  code,
}: {
  ingestKeySaved: boolean;
  runtime: ManualRuntime;
  onRuntimeChange: (runtime: ManualRuntime) => void;
  sdkPackage: string;
  code: string;
}) {
  return (
    <details className="mt-5 border-t pt-3">
      <summary className="cursor-pointer text-xs text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/50">Install manually</summary>
      <div className="mt-4 space-y-4">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Runtime">
          <Button variant={runtime === 'browser' ? 'default' : 'outline'} size="sm" onClick={() => onRuntimeChange('browser')}>React / Vite</Button>
          <Button variant={runtime === 'server' ? 'default' : 'outline'} size="sm" onClick={() => onRuntimeChange('server')}>Node / server</Button>
        </div>
        <CodeRow label="Install the SDK" code={`npm install ${sdkPackage}`} copyLabel="Copy install command" />
        <p className="text-xs text-muted-foreground">Keep the product key in the local environment you saved in the previous step.</p>
        <CodeRow label="Initialize and send one real event" code={code} copyLabel="Copy starter code" />
      </div>
    </details>
  );
}

function buildManualCode(serverUrl: string, runtime: ManualRuntime): string {
  const keyExpression = runtime === 'browser'
    ? 'import.meta.env.VITE_POOLSTATIS_INGEST_KEY'
    : 'process.env.VITE_POOLSTATIS_INGEST_KEY!';
  return `import { createClient } from '@poolstatis/sdk';

const analytics = createClient({
  url: '${serverUrl}',
  ingestKey: ${keyExpression},
});

// Replace this with one real product action and a stable user id.
analytics.track('signup.completed', user.id);`;
}

function CodeRow({ label, code, copyLabel }: { label: string; code: string; copyLabel: string }) {
  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="text-xs font-medium text-muted-foreground">{label}</div>
        <CopyButton value={code}>{copyLabel}</CopyButton>
      </div>
      <pre className="overflow-auto rounded-md border bg-background p-4 text-xs leading-relaxed">{code}</pre>
    </div>
  );
}

export function CopyButton({
  value,
  children,
  showFallback = false,
  disabled = false,
  onCopied,
  manualConfirmLabel,
}: {
  value: string;
  children: ReactNode;
  showFallback?: boolean;
  disabled?: boolean;
  onCopied?: () => void;
  manualConfirmLabel?: string;
}) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setFailed(false);
      setCopied(true);
      onCopied?.();
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      setFailed(true);
    }
  };
  return (
    <span className="inline-flex max-w-full flex-col items-start gap-2">
      <Button variant="outline" size="sm" onClick={() => void copy()} disabled={disabled}>
        {copied ? <Check className="size-3.5" aria-hidden="true" /> : <Copy className="size-3.5" aria-hidden="true" />}
        {copied ? 'Copied' : children}
      </Button>
      {failed && (
        <span role="alert" className="max-w-xl text-xs text-destructive">
          Copy was blocked by the browser.{showFallback ? ' Select the content below and copy it manually.' : ''}
        </span>
      )}
      {failed && showFallback && (
        <>
          <pre tabIndex={0} className="max-h-72 max-w-full overflow-auto whitespace-pre-wrap rounded-md border bg-background p-3 text-xs text-foreground">{value}</pre>
          {onCopied && manualConfirmLabel && <Button size="sm" onClick={onCopied}>{manualConfirmLabel}</Button>}
        </>
      )}
    </span>
  );
}

function containsCredentialValue(value: string): boolean {
  return /\b(?:pk|sk|pt)_[a-z0-9][a-z0-9_-]{3,}/i.test(value);
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
