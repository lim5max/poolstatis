import { useMemo, useState } from 'react';
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

type OnboardingStep = 1 | 2 | 3;

function slugify(value: string): string {
  const cleaned = value.toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return /^[a-z]/.test(cleaned) ? cleaned : cleaned ? `p-${cleaned}` : '';
}

export function Onboarding() {
  const { account, client, refreshProjects, setProject } = useStore();
  const [step, setStep] = useState<OnboardingStep>(1);
  const [projectName, setProjectName] = useState('My product');
  const [projectSlug, setProjectSlug] = useState('my-product');
  const [clientId, setClientId] = useState<McpClientId>('claude-code');
  const [jobId, setJobId] = useState<AnalyticsJobId>('activation');
  const [question, setQuestion] = useState('');
  const [result, setResult] = useState<HostedOnboardingResult | null>(null);
  const [savedSecrets, setSavedSecrets] = useState(false);
  const [requestCopied, setRequestCopied] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const selectedClient = mcpClientById(clientId);
  const selectedJob = analyticsJobById(jobId);
  const suggestedJob = useMemo(() => question.trim() ? suggestAnalyticsJob(question) : null, [question]);
  const activeStep: OnboardingStep = result ? 3 : step;
  const mcpConnection = useMemo(() => result
    ? mcpClientConfig(clientId, result.mcp.command, result.mcp.args, result.mcp.env.POOLSTATIS_URL, result.mcp.env.POOLSTATIS_TOKEN)
    : null, [clientId, result]);
  const agentRequest = useMemo(() => result
    ? buildAnalyticsAgentRequest({ jobId, question, project: result.project.slug, env: 'prod' })
    : '', [jobId, question, result]);

  const updateQuestion = (value: string) => {
    setQuestion(value);
    if (value.trim()) setJobId(suggestAnalyticsJob(value).id);
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
      setSavedSecrets(false);
    } catch (e) {
      setErr((e as Error).message);
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
    setProject(result.project.slug);
    await refreshProjects();
  };

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div>
        <div className="mb-1 text-xs text-muted-foreground">Step {activeStep} of 3</div>
        <h1 className="serif text-2xl font-normal">Get to your first answer</h1>
      </div>

      <OnboardingProgress step={activeStep} />

      {activeStep === 1 && (
        <Panel title={<h2>What do you want to learn?</h2>}>
          <p className="mb-4 text-sm text-muted-foreground">Choose a starting point or ask in your own words.</p>
          <div className="grid gap-2 sm:grid-cols-2" role="group" aria-label="Analytics job">
            {ANALYTICS_JOBS.map((job) => (
              <button
                key={job.id}
                type="button"
                aria-pressed={jobId === job.id}
                onClick={() => setJobId(job.id)}
                className={`rounded-md border p-3 text-left outline-none transition-colors hover:border-foreground/25 focus-visible:ring-2 focus-visible:ring-ring/50 ${jobId === job.id ? 'border-primary bg-primary/5' : 'bg-muted/15'}`}
              >
                <span className="block text-sm font-medium">{job.label}</span>
                <span className="mt-1 block text-xs text-muted-foreground">{job.description}</span>
              </button>
            ))}
          </div>

          <div className="mt-4 space-y-1.5">
            <Label htmlFor="onboarding-question" className="text-xs font-medium text-muted-foreground">Ask your own question</Label>
            <Textarea
              id="onboarding-question"
              value={question}
              maxLength={240}
              onChange={(event) => updateQuestion(event.target.value)}
              placeholder="Did the last release improve checkout conversion?"
              className="min-h-20"
            />
          </div>

          {suggestedJob && (
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-primary/40 bg-primary/5 px-3 py-2 text-sm" aria-live="polite">
              <span>Suggested: {suggestedJob.label}</span>
              {jobId !== suggestedJob.id && (
                <Button variant="ghost" size="sm" onClick={() => setJobId(suggestedJob.id)}>Use suggestion</Button>
              )}
            </div>
          )}

          <div className="mt-5 flex justify-end">
            <Button onClick={() => setStep(2)}>
              Continue
              <ArrowRight className="size-4" />
            </Button>
          </div>
        </Panel>
      )}

      {activeStep === 2 && (
        <Panel title={<h2>Name your product</h2>}>
          <div className="mb-4 rounded-md border bg-muted/15 px-3 py-2 text-sm">
            <span className="text-muted-foreground">First answer:</span>{' '}
            {question.trim() || selectedJob.label}
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

          <div className="mt-4 space-y-1.5">
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
            <p className="text-xs text-muted-foreground">Connection instructions will be formatted for {selectedClient.name}.</p>
          </div>

          {err && <div className="mt-4"><ErrorNote>{err}</ErrorNote></div>}

          <div className="mt-5 flex items-center justify-between gap-3">
            <Button variant="ghost" onClick={() => setStep(1)}>
              <ArrowLeft className="size-4" />
              Back
            </Button>
            <Button onClick={submit} disabled={busy || !projectName.trim() || !projectSlug.trim()}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : 'Create project'}
            </Button>
          </div>
        </Panel>
      )}

      {activeStep === 3 && result && (
        <Panel title={<h2>Give this to your agent</h2>}>
          <div className="rounded-md border border-primary/40 bg-primary/5 p-4">
            <div className="text-xs text-muted-foreground">Your first question</div>
            <div className="mt-1 text-sm font-medium">{question.trim() || selectedJob.label}</div>
            <Button className="mt-4" onClick={copyRequest}>
              {requestCopied ? <Check className="size-4" /> : <Copy className="size-4" />}
              {requestCopied ? 'Request copied' : 'Copy request'}
            </Button>
            <details className="mt-3" data-testid="hosted-agent-request">
              <summary className="cursor-pointer text-xs text-muted-foreground">Preview full request</summary>
              <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap rounded-md border bg-background p-3 text-xs leading-relaxed">{agentRequest}</pre>
            </details>
          </div>

          <div className="mt-5">
            <h3 className="text-sm font-medium">Save these once</h3>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              <TokenBox label="Personal MCP token" value={result.tokens.personal} />
              <TokenBox label="Prod ingest key" value={result.tokens.ingest_prod} />
            </div>
          </div>

          <details className="mt-4 rounded-md border bg-muted/10 px-3 py-2">
            <summary className="cursor-pointer text-sm font-medium">Connect {selectedClient.name}</summary>
            <div className="mt-3">
              <p className="mb-2 text-xs text-muted-foreground">{selectedClient.pasteTarget}</p>
              {result.mcp.package_status !== 'published' && (
                <ErrorNote>Registry install is disabled for this deploy. {result.mcp.note}</ErrorNote>
              )}
              <div className="mt-2"><CodeBlock code={mcpConnection?.code ?? ''} /></div>
            </div>
          </details>

          <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t pt-4">
            <label className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
              <input
                type="checkbox"
                checked={savedSecrets}
                onChange={(event) => setSavedSecrets(event.target.checked)}
                className="size-4 accent-primary"
              />
              I saved both keys.
            </label>
            <Button onClick={finish} disabled={!savedSecrets}>Open project</Button>
          </div>
        </Panel>
      )}
    </div>
  );
}

function OnboardingProgress({ step }: { step: OnboardingStep }) {
  const items = ['Question', 'Project', 'Agent'];
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
        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={copy}>
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <div className="mt-1 truncate font-mono text-xs" title={value}>{value}</div>
    </div>
  );
}

function CodeBlock({ code }: { code: string }) {
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
      <Button variant="outline" size="sm" className="absolute right-2 top-2 h-9" onClick={copy}>
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        {copied ? 'Copied' : 'Copy'}
      </Button>
      <pre className="max-h-64 overflow-auto rounded-md border bg-background p-4 pr-20 text-xs leading-relaxed">{code}</pre>
    </div>
  );
}
