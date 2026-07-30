import { useState } from 'react';
import { Loader2 } from '@/components/icons';
import { useStore, useAsync } from '../store';
import { Loading, ErrorNote, Panel, EmptyState, SecretReveal, Confirm, Overflow } from '../components/ui';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { ApiKeyRow } from '../api/types';

export function Keys() {
  const { client, project, tokenKind } = useStore();
  const { data, error, loading, reload } = useAsync(() => client!.keys(project!), [project]);
  const [fresh, setFresh] = useState<{ token: string; kind: string } | null>(null);
  const [revoking, setRevoking] = useState<ApiKeyRow | null>(null);

  if (loading) return <Loading what="reading keys…" />;
  if (error) return <ErrorNote>{error}</ErrorNote>;

  return (
    <div className="space-y-4">
      <IssueKey onIssued={(t, kind) => { setFresh({ token: t, kind }); reload(); }} issue={(b) => client!.issueKey(project!, b)} />
      {tokenKind === 'user' && (
        <IssuePersonalToken onIssued={(token) => setFresh({ token, kind: 'personal' })} issue={(b) => client!.issuePersonalToken(b)} />
      )}
      <Panel title={<>API keys <span className="font-sans text-muted-foreground text-sm font-normal ml-2">tokens are stored hashed — only the hash is kept</span></>}>
        {!data || data.length === 0 ? <EmptyState headline="No keys" lead="issue one above" /> : (
          <Table>
            <TableHeader><TableRow><TableHead>Kind</TableHead><TableHead>Token</TableHead><TableHead>Env</TableHead><TableHead>Label</TableHead><TableHead>Created</TableHead><TableHead>Status</TableHead><TableHead /></TableRow></TableHeader>
            <TableBody>
              {data.map((k) => (
                <TableRow key={k.id} className="group">
                  <TableCell><KindChip kind={k.kind} /></TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{mask(k.kind)}</TableCell>
                  <TableCell className="text-xs">{k.env}</TableCell>
                  <TableCell className="text-muted-foreground">{k.label ?? '—'}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{new Date(k.created_at).toLocaleDateString()}</TableCell>
                  <TableCell>{k.revoked_at ? <Badge variant="secondary" className="line-through opacity-70">revoked</Badge> : <Badge>active</Badge>}</TableCell>
                  <TableCell className="text-right">{!k.revoked_at && <div className="opacity-0 group-hover:opacity-100 transition-opacity"><Overflow items={[{ label: 'Revoke key', onClick: () => setRevoking(k), danger: true }]} /></div>}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Panel>
      {fresh && <SecretReveal token={fresh.token} kind={fresh.kind} onDone={() => setFresh(null)} />}
      {revoking && (
        <Confirm title={`Revoke this ${revoking.kind} key?`} tone="warn" confirmLabel="Revoke"
          body="Any caller using this key stops working immediately. This cannot be undone — issue a new key to replace it."
          onCancel={() => setRevoking(null)} onConfirm={async () => { await client!.revokeKey(project!, revoking.id); setRevoking(null); reload(); }} />
      )}
    </div>
  );
}

function KindChip({ kind }: { kind: string }) {
  const v = kind === 'secret' ? 'destructive' : kind === 'personal' ? 'default' : 'outline';
  return <Badge variant={v as any} className="font-normal">{kind}</Badge>;
}
function mask(kind: string): string { return kind === 'ingest' ? 'pk_••••' : kind === 'secret' ? 'sk_••••' : 'pt_••••'; }

function IssueKey({ issue, onIssued }: {
  issue: (b: { kind: 'ingest' | 'secret'; env?: string; label?: string }) => Promise<{ token: string }>;
  onIssued: (token: string, kind: string) => void;
}) {
  const [kind, setKind] = useState<'ingest' | 'secret'>('ingest');
  const [env, setEnv] = useState('prod');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true); setErr(null);
    try { const { token } = await issue({ kind, ...(kind === 'ingest' ? { env } : {}), ...(label.trim() ? { label: label.trim() } : {}) }); onIssued(token, kind); setLabel(''); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Panel title="Issue a key">
      <div className="flex items-end gap-3.5 flex-wrap">
        <div className="space-y-1.5">
          <Label className="text-xs font-medium text-muted-foreground">Kind</Label>
          <div className="flex rounded-field border overflow-hidden">
            {(['ingest', 'secret'] as const).map((k) => <button key={k} className={`h-9 px-3 text-xs ${kind === k ? 'bg-accent text-accent-foreground' : 'text-muted-foreground'}`} onClick={() => setKind(k)}>{k} ({k === 'ingest' ? 'pk_' : 'sk_'})</button>)}
          </div>
        </div>
        {kind === 'ingest' && (
          <div className="space-y-1.5">
            <Label className="text-xs font-medium text-muted-foreground">Env</Label>
            <Select value={env} onValueChange={setEnv}><SelectTrigger className="w-28"><SelectValue /></SelectTrigger><SelectContent>{['prod', 'dev', 'staging'].map((e) => <SelectItem key={e} value={e}>{e}</SelectItem>)}</SelectContent></Select>
          </div>
        )}
        <div className="flex-1 min-w-44 space-y-1.5"><Label className="text-xs font-medium text-muted-foreground">Label (opt)</Label><Input placeholder="e.g. web client" value={label} onChange={(e) => setLabel(e.target.value)} /></div>
        <Button onClick={submit} disabled={busy}>{busy ? <Loader2 className="size-4 animate-spin" /> : 'Issue key'}</Button>
      </div>
      <div className="text-xs text-muted-foreground mt-2.5">ingest keys (pk_) only write events; secret keys (sk_) read &amp; manage one project. Hosted admins can issue personal MCP tokens below.</div>
      {err && <div className="mt-3"><ErrorNote>{err}</ErrorNote></div>}
    </Panel>
  );
}

function IssuePersonalToken({ issue, onIssued }: {
  issue: (b: { label?: string }) => Promise<{ token: string }>;
  onIssued: (token: string) => void;
}) {
  const [label, setLabel] = useState('MCP client');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      const { token } = await issue(label.trim() ? { label: label.trim() } : {});
      onIssued(token);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Panel title="Issue personal MCP token">
      <div className="flex flex-wrap items-end gap-3.5">
        <div className="min-w-44 flex-1 space-y-1.5">
          <Label className="text-xs font-medium text-muted-foreground">Label</Label>
          <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Codex laptop" />
        </div>
        <Button onClick={submit} disabled={busy}>{busy ? <Loader2 className="size-4 animate-spin" /> : 'Issue pt_ token'}</Button>
      </div>
      <div className="mt-2.5 text-xs text-muted-foreground">
        Use <code>pt_</code> for org-wide MCP discovery. The token is shown once; store it before closing the dialog.
      </div>
      {err && <div className="mt-3"><ErrorNote>{err}</ErrorNote></div>}
    </Panel>
  );
}
