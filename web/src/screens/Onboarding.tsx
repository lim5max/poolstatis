import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Check, Copy, Loader2 } from '@/components/icons';
import { useStore } from '../store';
import { MCP_CLIENTS, mcpClientById, mcpClientConfig, type McpClientId } from '../mcpClients';
import {
  ANALYTICS_JOBS,
  analyticsJobById,
  buildAnalyticsAgentRequest,
  suggestAnalyticsJob,
  type AnalyticsJobId,
} from '../onboardingIntent';
import type { HostedOnboardingResult } from '../api/types';
import { ErrorNote, Panel } from '../components/ui';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue,
} from '@/components/ui/select';

type OnboardingStep = 1 | 2 | 3 | 4;
type SdkRuntime = 'browser' | 'node';

const SDK_PACKAGE = '@poolstatis/sdk@0.3.0';

function slugify(value: string): string {
  const cleaned = value.toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return /^[a-z]/.test(cleaned) ? cleaned : cleaned ? `p-${cleaned}` : '';
}

export function Onboarding() {
  const { account, client, refreshProjects, setProject } = useStore();
  const navigate = useNavigate();
  const [step, setStep] = useState<OnboardingStep>(1);
  const [projectName, setProjectName] = useState('My product');
  const [projectSlug, setProjectSlug] = useState('my-product');
  const [clientId, setClientId] = useState<McpClientId>('claude-code');
  const [jobIds, setJobIds] = useState<AnalyticsJobId[]>(['activation']);
  const [question, setQuestion] = useState('');
  const [sdkRuntime, setSdkRuntime] = useState<SdkRuntime>('browser');
  const [result, setResult] = useState<HostedOnboardingResult | null>(null);
  const [savedIngestKey, setSavedIngestKey] = useState(false);
  const [savedPersonalToken, setSavedPersonalToken] = useState(false);
  const [requestCopied, setRequestCopied] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const selectedClient = mcpClientById(clientId);
  const selectedJobs = jobIds.map(analyticsJobById);
  const suggestedJob = useMemo(() => question.trim() ? suggestAnalyticsJob(question) : null, [question]);
  const mcpConnection = useMemo(() => result
    ? mcpClientConfig(clientId, result.mcp.command, result.mcp.args, result.mcp.env.POOLSTATIS_URL, result.mcp.env.POOLSTATIS_TOKEN)
    : null, [clientId, result]);
  const agentRequest = useMemo(() => result
    ? buildAnalyticsAgentRequest({ jobIds, question, project: result.project.slug, env: 'prod' })
    : '', [jobIds, question, result]);
  const sdkCode = useMemo(() => result ? buildSdkStarter(result, sdkRuntime) : '', [result, sdkRuntime]);

  const toggleJob = (jobId: AnalyticsJobId) => {
    setJobIds((current) => {
      if (current.includes(jobId) && current.length === 1) return current;
      return current.includes(jobId)
        ? current.filter((id) => id !== jobId)
        : [...current, jobId];
    });
  };

  const continueFromGoals = () => {
    setStep(2);
  };

  const submit = async () => {
    if (!client) return;
    setBusy(true);
    setErr(null);
    try {
      const created = await client.completeOnboarding({
        workspace_name: account?.organization.name ?? 'Poolstatis workspace',
        project_name: projectName.trim(),
        project_slug: projectSlug.trim(),
      });
      setResult(created);
      setSavedIngestKey(false);
      setSavedPersonalToken(false);
      setStep(3);
    } catch (error) {
      setErr((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const copyRequest = async () => {
    try {
      await navigator.clipboard.writeText(agentRequest);
      setRequestCopied(true);
      setTimeout(() => setRequestCopied(false), 1400);
    } catch {
      // Clipboard can be blocked by browser policy.
    }
  };

  const finish = async () => {
    if (!result) return;
    setBusy(true);
    setErr(null);
    try {
      setProject(result.project.slug);
      await refreshProjects();
      navigate('/setup', { replace: true });
    } catch (error) {
      setErr((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div>
        <div className="mb-1 text-xs text-muted-foreground">Step {step} of 4</div>
        <h1 className="serif text-2xl font-normal">Get to your first answer</h1>
      </div>

      <OnboardingProgress step={step} />

      {step === 1 && (
        <Panel title={<h2>What do you want to learn?</h2>}>
          <p className="mb-4 text-sm text-muted-foreground">Choose one or more. You can refine this later.</p>
          <div className="grid gap-2 sm:grid-cols-2" role="group" aria-label="Analytics goals">
            {ANALYTICS_JOBS.map((job) => {
              const selected = jobIds.includes(job.id);
              return (
                <button
                  key={job.id}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => toggleJob(job.id)}
                  className={`rounded-md border p-3 text-left outline-none transition-colors hover:border-foreground/25 focus-visible:ring-2 focus-visible:ring-ring/50 ${selected ? 'border-primary bg-primary/5' : 'bg-muted/15'}`}
                >
                  <span className="flex items-center justify-between gap-2 text-sm font-medium">
                    {job.label}
                    {selected && <Check className="size-4 text-primary" />}
                  </span>
                  <span className="mt-1 block text-xs text-muted-foreground">{job.description}</span>
                </button>
              );
            })}
          </div>

          <div className="mt-4 space-y-1.5">
            <Label htmlFor="onboarding-question" className="text-xs font-medium text-muted-foreground">Or ask your own question</Label>
            <Textarea
              id="onboarding-question"
              value={question}
              maxLength={240}
              onChange={(event) => setQuestion(event.target.value)}
              placeholder="Did the last release improve checkout conversion?"
              className="min-h-20"
            />
          </div>

          {suggestedJob && (
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-primary/40 bg-primary/5 px-3 py-2 text-sm" aria-live="polite">
              <span>Suggested: {suggestedJob.label}</span>
              {!jobIds.includes(suggestedJob.id) && (
                <Button variant="ghost" size="sm" onClick={() => toggleJob(suggestedJob.id)}>Add suggestion</Button>
              )}
            </div>
          )}

          <div className="mt-5 flex items-center justify-between gap-3">
            <span className="text-xs text-muted-foreground">{jobIds.length} selected</span>
            <Button onClick={continueFromGoals}>
              Continue
              <ArrowRight className="size-4" />
            </Button>
          </div>
        </Panel>
      )}

      {step === 2 && (
        <Panel title={<h2>Name your product</h2>}>
          <div className="mb-4 flex flex-wrap gap-2" aria-label="Selected goals">
            {(selectedJobs.length ? selectedJobs : [analyticsJobById('activation')]).map((job) => (
              <span key={job.id} className="rounded-md border bg-muted/15 px-2 py-1 text-xs">{job.label}</span>
            ))}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="project-name" className="text-xs font-medium text-muted-foreground">Project name</Label>
            <Input
              id="project-name"
              value={projectName}
              onChange={(event) => {
                setProjectName(event.target.value);
                setProjectSlug(slugify(event.target.value));
              }}
            />
          </div>

          <details className="mt-3 rounded-md border bg-muted/10 px-3 py-2">
            <summary className="cursor-pointer text-xs text-muted-foreground">Advanced project settings</summary>
            <div className="mt-3 space-y-1.5">
              <Label htmlFor="project-slug" className="text-xs font-medium text-muted-foreground">Project slug</Label>
              <Input id="project-slug" value={projectSlug} onChange={(event) => setProjectSlug(slugify(event.target.value))} />
            </div>
          </details>

          {err && <div className="mt-4"><ErrorNote>{err}</ErrorNote></div>}

          <div className="mt-5 flex items-center justify-between gap-3">
            <Button variant="ghost" onClick={() => setStep(1)}>
              <ArrowLeft className="size-4" />
              Back
            </Button>
            <Button onClick={submit} disabled={busy || !projectName.trim() || !projectSlug.trim()}>
              {busy ? <><Loader2 className="size-4 animate-spin" />Creating…</> : 'Create project'}
            </Button>
          </div>
        </Panel>
      )}

      {step === 3 && result && (
        <Panel title={<h2>Install the SDK</h2>}>
          <div className="mb-4 flex items-center gap-2 rounded-md border border-primary/40 bg-primary/5 px-3 py-2 text-sm">
            <Check className="size-4 text-primary" />
            <span><strong>Project created</strong><span className="text-muted-foreground"> · Add the SDK to {result.project.name}.</span></span>
          </div>

          <div className="mb-4 flex gap-2" role="group" aria-label="SDK runtime">
            <Button variant={sdkRuntime === 'browser' ? 'default' : 'outline'} size="sm" aria-pressed={sdkRuntime === 'browser'} onClick={() => setSdkRuntime('browser')}>Browser</Button>
            <Button variant={sdkRuntime === 'node' ? 'default' : 'outline'} size="sm" aria-pressed={sdkRuntime === 'node'} onClick={() => setSdkRuntime('node')}>Node</Button>
          </div>

          <div className="space-y-4">
            <div>
              <div className="mb-2 text-xs font-medium text-muted-foreground">1. Install</div>
              <CodeBlock code={`npm install ${SDK_PACKAGE}`} copyLabel="Copy install command" />
            </div>
            <div>
              <div className="mb-2 text-xs font-medium text-muted-foreground">2. Start collection</div>
              <CodeBlock code={sdkCode} copyLabel="Copy SDK starter" />
              {sdkRuntime === 'browser' && (
                <p className="mt-2 text-xs text-muted-foreground">Replace <code>home</code> and <code>other</code> with your finite route names.</p>
              )}
            </div>
            <div>
              <div className="mb-2 text-xs font-medium text-muted-foreground">3. Save the write-only key</div>
              <TokenBox label="Prod ingest key" value={result.tokens.ingest_prod} />
            </div>
          </div>

          <label className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
            <input
              type="checkbox"
              checked={savedIngestKey}
              onChange={(event) => setSavedIngestKey(event.target.checked)}
              className="size-4 accent-primary"
            />
            I saved the ingest key.
          </label>

          <div className="mt-5 flex justify-end">
            <Button onClick={() => setStep(4)} disabled={!savedIngestKey}>
              Continue to MCP
              <ArrowRight className="size-4" />
            </Button>
          </div>
        </Panel>
      )}

      {step === 4 && result && (
        <Panel title={<h2>Connect MCP</h2>}>
          <p className="mb-4 text-sm text-muted-foreground">Optional. Connect your coding agent now, or finish this later in Setup &amp; MCP.</p>

          <div className="space-y-1.5">
            <Label className="text-xs font-medium text-muted-foreground">Coding agent</Label>
            <Select value={clientId} onValueChange={(value) => setClientId(value as McpClientId)}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Choose coding agent" />
              </SelectTrigger>
              <SelectContent>
                {(['Popular MCP hosts', 'IDE agents', 'Advanced/custom'] as const).map((group, index) => (
                  <SelectGroup key={group}>
                    {index > 0 && <SelectSeparator />}
                    <SelectLabel>{group}</SelectLabel>
                    {MCP_CLIENTS.filter((item) => item.group === group).map((item) => (
                      <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>
                    ))}
                  </SelectGroup>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{selectedClient.pasteTarget}</p>
          </div>

          <div className="mt-4">
            <TokenBox label="Personal MCP token" value={result.tokens.personal} />
          </div>

          {result.mcp.package_status !== 'published' && (
            <div className="mt-3"><ErrorNote>Registry install is disabled for this deploy. {result.mcp.note}</ErrorNote></div>
          )}

          <div className="mt-4">
            <CodeBlock code={mcpConnection?.code ?? ''} copyLabel={`Copy ${selectedClient.name} config`} />
          </div>

          <div className="mt-5 rounded-md border border-primary/40 bg-primary/5 p-4">
            <h3 className="text-sm font-medium">Give this to your agent</h3>
            <p className="mt-1 text-xs text-muted-foreground">It will instrument the goals you selected and verify the first answer.</p>
            <Button className="mt-3" onClick={copyRequest}>
              {requestCopied ? <Check className="size-4" /> : <Copy className="size-4" />}
              {requestCopied ? 'Request copied' : 'Copy request'}
            </Button>
            <details className="mt-3" data-testid="hosted-agent-request">
              <summary className="cursor-pointer text-xs text-muted-foreground">Preview request</summary>
              <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap rounded-md border bg-background p-3 text-xs leading-relaxed">{agentRequest}</pre>
            </details>
          </div>

          <label className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
            <input
              type="checkbox"
              checked={savedPersonalToken}
              onChange={(event) => setSavedPersonalToken(event.target.checked)}
              className="size-4 accent-primary"
            />
            I saved the MCP token.
          </label>

          {err && <div className="mt-4"><ErrorNote>{err}</ErrorNote></div>}

          <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t pt-4">
            <Button variant="ghost" onClick={finish} disabled={busy}>Skip for now</Button>
            <Button onClick={finish} disabled={busy || !savedPersonalToken}>
              {busy ? <><Loader2 className="size-4 animate-spin" />Opening…</> : 'Open setup checklist'}
            </Button>
          </div>
        </Panel>
      )}
    </div>
  );
}

function OnboardingProgress({ step }: { step: OnboardingStep }) {
  const items = ['Goals', 'Project', 'SDK', 'MCP'];
  return (
    <ol className="flex" aria-label="Onboarding progress">
      {items.map((label, index) => {
        const number = (index + 1) as OnboardingStep;
        const complete = number < step;
        const active = number === step;
        return (
          <li key={label} className="min-w-0 flex-1" aria-current={active ? 'step' : undefined}>
            <div className="flex items-center">
              <span className={`relative z-10 grid size-8 shrink-0 place-items-center rounded-control border text-xs font-semibold ${active || complete ? 'border-primary bg-primary text-primary-foreground' : 'bg-background text-muted-foreground'}`}>
                {complete ? <Check className="size-4" /> : number}
              </span>
              {index < items.length - 1 && <span className={`mx-2 h-px flex-1 ${complete ? 'bg-primary' : 'bg-border'}`} />}
            </div>
            <span className={`mt-1.5 block text-xs ${active ? 'text-foreground' : 'text-muted-foreground'}`}>{label}</span>
          </li>
        );
      })}
    </ol>
  );
}

function buildSdkStarter(result: HostedOnboardingResult, runtime: SdkRuntime): string {
  const base = [
    "import { createClient } from '@poolstatis/sdk';",
    '',
    'const analytics = createClient({',
    `  url: ${JSON.stringify(result.mcp.env.POOLSTATIS_URL)},`,
    `  ingestKey: ${JSON.stringify(result.tokens.ingest_prod)},`,
    '});',
  ];
  if (runtime === 'node') {
    return [
      ...base,
      '',
      "analytics.track('signup.completed', user.id);",
    ].join('\n');
  }
  return [
    "import { createBrowserAnalytics } from '@poolstatis/sdk/browser';",
    ...base,
    '',
    'const browser = createBrowserAnalytics({',
    '  client: analytics,',
    '  mapPagePath: (pathname) => {',
    "    if (pathname === '/') return 'home';",
    "    return 'other';",
    '  },',
    '});',
    '',
    'browser.start();',
  ].join('\n');
}

function TokenBox({ label, value }: { label: string; value: string }) {
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
    <div className="min-w-0 rounded-md border bg-background p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="text-xs text-muted-foreground">{label}</div>
        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={copy} aria-label={`Copy ${label}`}>
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <div className="mt-1 truncate font-mono text-xs" title={value}>{value}</div>
    </div>
  );
}

function CodeBlock({ code, copyLabel }: { code: string; copyLabel: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      // Clipboard can be blocked by browser policy.
    }
  };
  return (
    <div className="relative min-w-0">
      <Button variant="outline" size="sm" className="absolute right-2 top-2 h-9" onClick={copy} aria-label={copyLabel}>
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        {copied ? 'Copied' : 'Copy'}
      </Button>
      <pre className="max-h-64 overflow-auto rounded-md border bg-background p-4 pr-20 text-xs leading-relaxed">{code}</pre>
    </div>
  );
}
