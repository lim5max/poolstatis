import { useMemo, useState } from 'react';
import { Loader2 } from '@/components/icons';
import { useStore, useAsync } from '../store';
import {
  Confirm,
  EmptyState,
  ErrorNote,
  Loading,
  OneTimeTokenReveal,
  Overflow,
  Panel,
  RecoverableError,
  TableScroll,
  fmtRelative,
} from '../components/ui';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type {
  ApiKeyRow,
  CredentialRotationPolicy,
  CredentialRotationRecommendation,
  PersonalToken,
} from '../api/types';
import { credentialPermissions } from '../analysis/semanticHealth';

type IssuableKind = 'ingest' | 'secret' | 'personal';

interface KeyListItem {
  id: string;
  kind: IssuableKind;
  token: string;
  label: string | null;
  scope: string;
  env: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  owner: 'project' | 'personal';
  credentialPolicy: CredentialRotationPolicy;
  rotationRecommendation: CredentialRotationRecommendation;
}

export function Keys() {
  const { client, project, tokenKind } = useStore();
  const projectKeys = useAsync(async () => ({
    project: project!,
    keys: await client!.keys(project!),
  }), [client, project]);
  const personalTokens = useAsync(
    () => tokenKind === 'user' ? client!.personalTokens() : Promise.resolve([]),
    [client, tokenKind],
  );
  const [fresh, setFresh] = useState<{ token: string; kind: IssuableKind } | null>(null);
  const [inspecting, setInspecting] = useState<KeyListItem | null>(null);
  const [revoking, setRevoking] = useState<KeyListItem | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const currentProjectKeys = projectKeys.data?.project === project
    ? projectKeys.data.keys
    : null;

  const rows = useMemo(() => {
    const projectRows = (currentProjectKeys ?? []).map((key): KeyListItem => projectKeyRow(key, project!));
    const personalRows = tokenKind === 'user'
      ? (personalTokens.data ?? []).map(personalKeyRow)
      : [];
    return [...projectRows, ...personalRows]
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }, [currentProjectKeys, personalTokens.data, project, tokenKind]);

  if ((projectKeys.loading && currentProjectKeys === null)
    || (tokenKind === 'user' && personalTokens.loading && personalTokens.data === null)) {
    return <Loading what="Reading keys…" />;
  }
  if (projectKeys.error && currentProjectKeys === null) {
    return <RecoverableError onRetry={projectKeys.reload}>{projectKeys.error}</RecoverableError>;
  }
  if (tokenKind === 'user' && personalTokens.error && personalTokens.data === null) {
    return <RecoverableError onRetry={personalTokens.reload}>{personalTokens.error}</RecoverableError>;
  }

  const reloadFor = (kind: IssuableKind) => {
    if (kind === 'personal') personalTokens.reload();
    else projectKeys.reload();
  };

  const revoke = async () => {
    if (!revoking) return;
    setRevokeError(null);
    try {
      if (revoking.owner === 'personal') {
        await client!.revokePersonalToken(revoking.id);
        personalTokens.reload();
      } else {
        await client!.revokeKey(project!, revoking.id);
        projectKeys.reload();
      }
      setRevoking(null);
    } catch (error) {
      setRevokeError((error as Error).message);
    }
  };

  const refreshError = projectKeys.error ?? (
    tokenKind === 'user' ? personalTokens.error : null
  );
  const healthCounts = rows.reduce((counts, row) => {
    const status = keyHealth(row).status;
    if (status === 'review') counts.attention += 1;
    else if (status === 'healthy') counts.healthy += 1;
    return counts;
  }, { healthy: 0, attention: 0 });
  const policySummaries = [...new Set(rows.map(policySummary))];

  return (
    <div className="space-y-4">
      <CreateKey
        project={project!}
        canIssuePersonal={tokenKind === 'user'}
        issueProject={(body) => client!.issueKey(project!, body)}
        issuePersonal={(body) => client!.issuePersonalToken(body)}
        onIssued={(token, kind) => {
          setFresh({ token, kind });
        }}
      />

      <Panel
        title={<h2>Credential health</h2>}
        right={<span className="text-xs text-muted-foreground">{healthCounts.healthy} healthy · {healthCounts.attention} need review</span>}
      >
        {rows.length === 0 ? <EmptyState headline="No keys" lead="Create one above." /> : (
          <TableScroll>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Key</TableHead>
                  <TableHead>Scope</TableHead>
                  <TableHead>Label</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Last used</TableHead>
                  <TableHead>Health</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((key) => (
                  <TableRow key={`${key.owner}-${key.id}`}>
                    <TableCell>
                      <button
                        type="button"
                        className="group inline-flex items-center gap-2 rounded-sm text-left outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                        onClick={() => setInspecting(key)}
                        aria-label={`View ${key.token} details`}
                      >
                        <KindChip kind={key.kind} />
                        <code className="font-mono text-xs text-muted-foreground group-hover:text-foreground">{key.token}</code>
                      </button>
                    </TableCell>
                    <TableCell>
                      <div className="text-sm">{key.scope}</div>
                      {key.env && <div className="font-mono text-xs text-muted-foreground">{key.env}</div>}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{key.label ?? '—'}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{fmtRelative(key.createdAt)}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{key.lastUsedAt ? fmtRelative(key.lastUsedAt) : 'Never'}</TableCell>
                    <TableCell><CredentialHealthBadge item={key} /></TableCell>
                    <TableCell>
                      {key.revokedAt
                        ? <Badge variant="secondary" className="line-through opacity-70">revoked</Badge>
                        : <Badge>active</Badge>}
                    </TableCell>
                    <TableCell className="text-right">
                      <Overflow items={[
                        { label: 'View details', onClick: () => setInspecting(key) },
                        ...(!key.revokedAt ? [{
                          label: 'Revoke key',
                          onClick: () => {
                            setRevokeError(null);
                            setRevoking(key);
                          },
                          danger: true,
                        }] : []),
                      ]} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableScroll>
        )}
        <p className="mt-3 text-xs text-muted-foreground">
          Rotation is replacement-first: create a new key, verify its consumer, then revoke the predecessor. Plaintext keys cannot be recovered.
        </p>
        {policySummaries.map((summary) => (
          <p key={summary} className="mt-1 text-xs text-muted-foreground">{summary}</p>
        ))}
        {refreshError && (
          <div className="mt-3">
            <ErrorNote>Could not refresh the key list: {refreshError}</ErrorNote>
          </div>
        )}
      </Panel>

      {fresh && (
        <OneTimeTokenReveal
          token={fresh.token}
          title={fresh.kind === 'personal' ? 'New workspace MCP token' : `New ${prefix(fresh.kind)} key`}
          onDismiss={() => {
            const issuedKind = fresh.kind;
            setFresh(null);
            reloadFor(issuedKind);
          }}
        />
      )}
      {inspecting && <KeyDetails item={inspecting} onDone={() => setInspecting(null)} />}
      {revoking && (
        <Confirm
          title={`Revoke ${revoking.token}?`}
          tone="warn"
          confirmLabel="Revoke"
          body={`Scope: ${revoking.scope}${revoking.env ? ` · ${revoking.env}` : ''}. Permissions: ${credentialPermissions(revoking.kind)} Authentication with this key fails immediately. Create and verify a replacement before revoking if it is still in use.`}
          error={revokeError ?? undefined}
          onCancel={() => {
            setRevokeError(null);
            setRevoking(null);
          }}
          onConfirm={revoke}
        />
      )}
    </div>
  );
}

function projectKeyRow(key: ApiKeyRow, project: string): KeyListItem {
  const token = key.masked_token.endsWith('...')
    ? `${key.masked_token} · key ${key.id.slice(0, 8)}`
    : key.masked_token;
  return {
    id: key.id,
    kind: key.kind as 'ingest' | 'secret',
    token,
    label: key.label,
    scope: `${project} only`,
    env: key.kind === 'ingest' ? key.env : null,
    createdAt: key.created_at,
    lastUsedAt: key.last_used_at,
    revokedAt: key.revoked_at,
    owner: 'project',
    credentialPolicy: key.credential_policy,
    rotationRecommendation: key.rotation_recommendation,
  };
}

function personalKeyRow(token: PersonalToken): KeyListItem {
  return {
    id: token.id,
    kind: 'personal',
    token: token.token,
    label: token.label,
    scope: 'All projects',
    env: null,
    createdAt: token.created_at,
    lastUsedAt: token.last_used_at,
    revokedAt: token.revoked_at,
    owner: 'personal',
    credentialPolicy: token.credential_policy,
    rotationRecommendation: token.rotation_recommendation,
  };
}

function KindChip({ kind }: { kind: IssuableKind }) {
  const variant = kind === 'personal' ? 'default' : 'outline';
  return <Badge variant={variant} className="font-normal">{prefix(kind)}</Badge>;
}

function keyHealth(item: KeyListItem) {
  return item.rotationRecommendation;
}

function policySummary(item: KeyListItem): string {
  const policy = item.credentialPolicy;
  const source = policy.source === 'poolstatis_core_default' ? 'Core' : policy.source;
  return `${source} ${policy.mode} policy v${policy.version} · review at ${policy.thresholds.age_review_days}d age, ${policy.thresholds.idle_review_days}d idle, or ${policy.thresholds.unused_review_days}d unused; no automatic expiry.`;
}

function CredentialHealthBadge({ item }: { item: KeyListItem }) {
  const health = keyHealth(item);
  return <Badge variant={health.status === 'revoked' ? 'destructive' : health.status === 'healthy' ? 'default' : 'outline'}>{health.label}</Badge>;
}

function prefix(kind: IssuableKind): 'pk_' | 'sk_' | 'pt_' {
  if (kind === 'ingest') return 'pk_';
  if (kind === 'secret') return 'sk_';
  return 'pt_';
}

const kindOptions: Array<{
  kind: IssuableKind;
  label: string;
  description: (project: string, env: string) => string;
  placeholder: string;
}> = [
  {
    kind: 'ingest',
    label: 'Ingest · pk_',
    description: (project, env) => `Write events to ${project} · ${env}. Cannot read data.`,
    placeholder: 'e.g. Browser SDK',
  },
  {
    kind: 'secret',
    label: 'Project MCP · sk_',
    description: (project) => `Read and manage ${project} only.`,
    placeholder: 'e.g. Codex for this project',
  },
  {
    kind: 'personal',
    label: 'Workspace MCP · pt_',
    description: () => 'Every project in this workspace.',
    placeholder: 'e.g. Codex workspace',
  },
];

function CreateKey({
  project,
  canIssuePersonal,
  issueProject,
  issuePersonal,
  onIssued,
}: {
  project: string;
  canIssuePersonal: boolean;
  issueProject: (body: { kind: 'ingest' | 'secret'; env?: string; label?: string }) => Promise<{ token: string }>;
  issuePersonal: (body: { label?: string }) => Promise<{ token: string }>;
  onIssued: (token: string, kind: IssuableKind) => void;
}) {
  const available = canIssuePersonal ? kindOptions : kindOptions.filter((option) => option.kind !== 'personal');
  const [kind, setKind] = useState<IssuableKind>('ingest');
  const [env, setEnv] = useState('prod');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selected = available.find((option) => option.kind === kind) ?? available[0]!;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = label.trim() ? { label: label.trim() } : {};
      const result = kind === 'personal'
        ? await issuePersonal(body)
        : await issueProject({
          kind,
          ...(kind === 'ingest' ? { env } : {}),
          ...body,
        });
      onIssued(result.token, kind);
      setLabel('');
    } catch (issueError) {
      setError((issueError as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title={<h2>Create a key</h2>}>
      <div className="grid gap-4">
        <div className="flex flex-wrap gap-2" aria-label="Key type">
          {available.map((option) => (
            <button
              key={option.kind}
              type="button"
              aria-pressed={kind === option.kind}
              className={`h-9 rounded-md border px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                kind === option.kind
                  ? 'border-brand-strong bg-primary/10 text-foreground'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              }`}
              onClick={() => setKind(option.kind)}
            >
              {option.label}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-end gap-3">
          {kind === 'ingest' && (
            <div className="space-y-1.5">
              <Label htmlFor="key-env" className="text-xs text-muted-foreground">Environment</Label>
              <Select value={env} onValueChange={setEnv}>
                <SelectTrigger id="key-env" className="w-28" aria-label="Environment"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {['prod', 'dev', 'staging'].map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="min-w-44 flex-1 space-y-1.5">
            <Label htmlFor="key-label" className="text-xs text-muted-foreground">Label</Label>
            <Input
              id="key-label"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder={selected.placeholder}
            />
          </div>
          <Button onClick={submit} disabled={busy}>
            {busy ? <><Loader2 className="size-4 animate-spin" />Creating…</> : `Create ${prefix(kind)} token`}
          </Button>
        </div>

        <p className="text-xs text-muted-foreground">{selected.description(project, env)}</p>
        {error && <ErrorNote>{error}</ErrorNote>}
      </div>
    </Panel>
  );
}

function KeyDetails({ item, onDone }: { item: KeyListItem; onDone: () => void }) {
  const title = item.kind === 'ingest'
    ? 'Ingest key'
    : item.kind === 'secret'
      ? 'Project MCP key'
      : 'Workspace MCP token';
  const health = keyHealth(item);
  return (
    <Dialog open onOpenChange={(open) => !open && onDone()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="serif font-normal text-xl">{title}</DialogTitle>
          <DialogDescription><code className="font-mono">{item.token}</code></DialogDescription>
        </DialogHeader>
        <dl className="grid grid-cols-2 gap-3 rounded-md border p-3 text-sm">
          <div><dt className="text-xs text-muted-foreground">Scope</dt><dd className="mt-1">{item.scope}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Environment</dt><dd className="mt-1 font-mono">{item.env ?? 'all'}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Created</dt><dd className="mt-1">{fmtRelative(item.createdAt)}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Last used</dt><dd className="mt-1">{item.lastUsedAt ? fmtRelative(item.lastUsedAt) : 'Not recorded'}</dd></div>
          <div className="col-span-2"><dt className="text-xs text-muted-foreground">Permissions</dt><dd className="mt-1">{credentialPermissions(item.kind)}</dd></div>
        </dl>
        <div className="rounded-md border p-3 text-sm"><div className="font-medium">{health.label}</div><p className="mt-1 text-xs text-muted-foreground">{health.recommendation}</p></div>
        <p className="text-xs text-muted-foreground">{policySummary(item)}</p>
        <div className="rounded-md bg-muted/50 p-3 text-sm">
          <p className="font-medium">The full key cannot be shown again.</p>
          <p className="mt-1 text-xs text-muted-foreground">Poolstatis does not store its plaintext.</p>
        </div>
        <DialogFooter><Button onClick={onDone}>Done</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
