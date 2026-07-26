import { useMemo, useState, type ReactNode } from 'react';
import { Check, Copy, KeyRound, Loader2, Settings } from '@/components/icons';
import { useStore } from '../store';
import { MCP_CLIENTS, mcpClientById, mcpServerConfig, type McpClientId } from '../mcpClients';
import type { HostedOnboardingResult } from '../api/types';
import { Panel, ErrorNote } from '../components/ui';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue,
} from '@/components/ui/select';

function slugify(value: string): string {
  const cleaned = value.toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return /^[a-z]/.test(cleaned) ? cleaned : cleaned ? `p-${cleaned}` : '';
}

export function Onboarding() {
  const { account, client, refreshProjects, setProject } = useStore();
  const [projectName, setProjectName] = useState('My product');
  const [projectSlug, setProjectSlug] = useState('my-product');
  const [clientId, setClientId] = useState<McpClientId>('claude-code');
  const [result, setResult] = useState<HostedOnboardingResult | null>(null);
  const [savedSecrets, setSavedSecrets] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const selectedClient = mcpClientById(clientId);
  const mcpConfig = useMemo(() => result
    ? mcpServerConfig(result.mcp.command, result.mcp.args, result.mcp.env.POOLSTATIS_URL, result.mcp.env.POOLSTATIS_TOKEN)
    : '', [result]);

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

  const finish = async () => {
    if (!result) return;
    setProject(result.project.slug);
    await refreshProjects();
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
      <Panel title="Create your first project">
        <div className="mb-5 grid gap-3 md:grid-cols-2">
          <Step icon={<KeyRound className="size-4" />} title="Project" body="Create the first data boundary." />
          <Step icon={<Settings className="size-4" />} title="MCP" body="Choose the client and copy the config." />
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="project-name" className="text-xs font-medium text-muted-foreground">Project name</Label>
            <Input
              id="project-name"
              value={projectName}
              onChange={(e) => {
                setProjectName(e.target.value);
                setProjectSlug(slugify(e.target.value));
              }}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="project-slug" className="text-xs font-medium text-muted-foreground">Project slug</Label>
            <Input id="project-slug" value={projectSlug} onChange={(e) => setProjectSlug(slugify(e.target.value))} />
          </div>
        </div>

        <div className="mt-5 space-y-2">
          <Label className="text-xs font-medium text-muted-foreground">MCP client template</Label>
          <Select value={clientId} onValueChange={(value) => setClientId(value as McpClientId)}>
            <SelectTrigger className="w-full md:w-80">
              <SelectValue placeholder="Choose MCP client" />
            </SelectTrigger>
            <SelectContent>
              {(['Popular MCP hosts', 'IDE agents', 'Advanced/custom'] as const).map((group, index) => (
                <SelectGroup key={group}>
                  {index > 0 && <SelectSeparator />}
                  <SelectLabel>{group}</SelectLabel>
                  {MCP_CLIENTS.filter((client) => client.group === group).map((client) => (
                    <SelectItem key={client.id} value={client.id}>{client.name}</SelectItem>
                  ))}
                </SelectGroup>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {selectedClient.description} Poolstatis uses the same stdio command, args, and env; paste location depends on the host.
          </p>
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-3">
          <Button onClick={submit} disabled={busy || !projectName.trim() || !projectSlug.trim()}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : 'Create first project'}
          </Button>
          <span className="text-xs text-muted-foreground">Tokens are shown once. Store them before leaving this screen.</span>
        </div>
        {err && <div className="mt-4"><ErrorNote>{err}</ErrorNote></div>}
      </Panel>

      <Panel title="What this creates">
        <div className="space-y-3 text-sm text-muted-foreground">
          <ChecklistItem>The existing organization remains the tenant boundary.</ChecklistItem>
          <ChecklistItem>One project with prod ingest key.</ChecklistItem>
          <ChecklistItem>One personal token for MCP clients.</ChecklistItem>
          <ChecklistItem>{selectedClient.name} instructions stay visible after setup.</ChecklistItem>
          <ChecklistItem>Billing meter definitions are stored for future usage reports, but not billed.</ChecklistItem>
        </div>
      </Panel>

      {result && (
        <div className="lg:col-span-2">
          <Panel title={<>{selectedClient.name} MCP config <Badge variant="outline" className="ml-2 font-mono">token shown once</Badge></>}>
            <p className="mb-3.5 text-sm text-muted-foreground">{selectedClient.pasteTarget}</p>
            {result.mcp.package_status !== 'published' && (
              <div className="mb-3.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-xs text-amber-200">
                MCP runner is publish-ready but not marked as published for this hosted deploy. {result.mcp.note}
              </div>
            )}
            <div className="grid gap-4 lg:grid-cols-[1.3fr_0.7fr]">
              <CodeBlock code={mcpConfig} />
              <div className="space-y-3">
                <TokenBox label="Personal MCP token" value={result.tokens.personal} />
                <TokenBox label="Prod ingest key" value={result.tokens.ingest_prod} />
              </div>
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-3 border-t pt-4">
              <label className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
                <input
                  type="checkbox"
                  checked={savedSecrets}
                  onChange={(e) => setSavedSecrets(e.target.checked)}
                  className="size-4 accent-primary"
                />
                I saved the personal MCP token and prod ingest key.
              </label>
              <Button onClick={finish} disabled={!savedSecrets}>Open project</Button>
            </div>
          </Panel>
        </div>
      )}
    </div>
  );
}

function Step({ icon, title, body }: { icon: ReactNode; title: string; body: string }) {
  return (
    <div className="rounded-md border bg-muted/20 p-3.5">
      <div className="mb-2 flex items-center gap-2 text-sm font-medium">{icon}{title}</div>
      <p className="text-xs leading-relaxed text-muted-foreground">{body}</p>
    </div>
  );
}

function ChecklistItem({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-2">
      <Check className="mt-0.5 size-3.5 text-primary" />
      <span>{children}</span>
    </div>
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
    <div className="rounded-md border bg-background p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="text-xs text-muted-foreground">{label}</div>
        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={copy}>
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <div className="mt-1 break-all font-mono text-xs">{value}</div>
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
      <pre className="overflow-auto rounded-md border bg-background p-4 pr-20 text-xs leading-relaxed">{code}</pre>
    </div>
  );
}
