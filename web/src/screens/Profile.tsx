import { useEffect, useState } from 'react';
import { useAuth0 } from '@auth0/auth0-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Confirm, EmptyState, ErrorNote, FieldLabel, Loading, OneTimeTokenReveal, Panel, TableScroll, fmtRelative } from '../components/ui';
import { useAsync, useStore } from '../store';

function ProfileUnavailable() {
  return <Panel title="Profile"><EmptyState headline="Hosted profile unavailable" lead="Sign in with a hosted account to manage your identity and personal tokens." /></Panel>;
}

/** This outer guard deliberately never invokes Auth0 hooks for self-host key sessions. */
export function Profile() {
  const { tokenKind } = useStore();
  if (tokenKind !== 'user') return <ProfileUnavailable />;
  return <HostedProfile />;
}

function HostedProfile() {
  const { account, client, disconnect, refreshAccount } = useStore();
  const { logout } = useAuth0();
  const [displayName, setDisplayName] = useState(account?.user.display_name ?? '');
  const [profileError, setProfileError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [label, setLabel] = useState('');
  const [issuing, setIssuing] = useState(false);
  const [revealed, setRevealed] = useState<string | null>(null);
  const [revoke, setRevoke] = useState<{ id: string; label: string } | null>(null);
  const tokens = useAsync(() => client ? client.personalTokens() : Promise.resolve([]), [client]);

  useEffect(() => setDisplayName(account?.user.display_name ?? ''), [account?.user.display_name]);

  if (!account || !client) return <ProfileUnavailable />;
  const canIssue = account.membership.role === 'owner' || account.membership.role === 'admin';

  const saveProfile = async () => {
    setSaving(true);
    setProfileError(null);
    try {
      await client.updateProfile({ display_name: displayName.trim() });
      await refreshAccount();
    } catch (error) {
      setProfileError((error as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const createToken = async () => {
    setIssuing(true);
    setProfileError(null);
    try {
      const created = await client.issuePersonalToken(label.trim() ? { label: label.trim() } : {});
      setLabel('');
      setRevealed(created.token);
      tokens.reload();
    } catch (error) {
      setProfileError((error as Error).message);
    } finally {
      setIssuing(false);
    }
  };

  const revokeToken = async () => {
    if (!revoke) return;
    setProfileError(null);
    try {
      await client.revokePersonalToken(revoke.id);
      setRevoke(null);
      tokens.reload();
    } catch (error) {
      setProfileError((error as Error).message);
    }
  };

  const signOut = () => {
    disconnect();
    logout({ logoutParams: { returnTo: window.location.origin } });
  };

  const initial = (account.user.display_name || account.user.email || '?').slice(0, 1).toUpperCase();
  return (
    <div className="space-y-4">
      <Panel title="Profile" right={<Button variant="outline" onClick={signOut}>Log out</Button>}>
        <div className="grid gap-6 md:flex md:items-start">
          {account.user.picture_url ? <img className="size-16 rounded-full border object-cover" src={account.user.picture_url} alt="Profile avatar" /> : <div className="flex size-16 items-center justify-center rounded-full border bg-muted font-medium text-xl" aria-label="Profile avatar">{initial}</div>}
          <div className="min-w-0 space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div><FieldLabel>Verified email</FieldLabel><div className="mt-1 break-all text-sm">{account.user.email_verified ? account.user.email ?? 'Verified address unavailable' : 'Email verification required'}</div></div>
              <div><FieldLabel>Workspace role</FieldLabel><div className="mt-1 text-sm capitalize">{account.membership.role}</div></div>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <div className="min-w-0 flex-1 space-y-1.5"><Label htmlFor="display-name" className="text-xs text-muted-foreground">Display name</Label><Input id="display-name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></div>
              <Button onClick={saveProfile} disabled={saving || !displayName.trim()}>{saving ? 'Saving…' : 'Save profile'}</Button>
            </div>
          </div>
        </div>
        {profileError && !revoke && <div className="mt-4"><ErrorNote>{profileError}</ErrorNote></div>}
      </Panel>

      <Panel title="Personal tokens" right={canIssue ? <Button onClick={createToken} disabled={issuing}>{issuing ? 'Creating…' : 'Create personal token'}</Button> : <span className="text-xs text-muted-foreground">Only owners and admins can issue tokens.</span>}>
        {canIssue && <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="min-w-0 flex-1 space-y-1.5"><Label htmlFor="token-label" className="text-xs text-muted-foreground">Label</Label><Input id="token-label" value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Local MCP" /></div>
          <p className="text-xs text-muted-foreground">Tokens are shown in plaintext once, then remain masked.</p>
        </div>}
        {tokens.loading ? <Loading what="Loading personal tokens…" /> : tokens.error ? <ErrorNote>{tokens.error}</ErrorNote> : tokens.data?.length === 0 ? <EmptyState headline="No personal tokens" lead="Create one for an MCP client or coding agent." /> : (
          <TableScroll testId="personal-tokens-scroll"><Table>
            <TableHeader><TableRow><TableHead>Token</TableHead><TableHead>Created</TableHead><TableHead>Last used</TableHead><TableHead>Status</TableHead><TableHead /></TableRow></TableHeader>
            <TableBody>{tokens.data?.map((token) => <TableRow key={token.id}>
              <TableCell><div className="font-medium">{token.label ?? 'Personal token'}</div><code className="mono text-xs text-muted-foreground">{token.token}</code></TableCell>
              <TableCell className="text-xs text-muted-foreground">{fmtRelative(token.created_at)}</TableCell>
              <TableCell className="text-xs text-muted-foreground">{fmtRelative(token.last_used_at)}</TableCell>
              <TableCell className="text-xs">{token.revoked_at ? 'Revoked' : 'Active'}</TableCell>
              <TableCell className="text-right">{token.revoked_at ? <span className="text-xs text-muted-foreground">audit retained</span> : <Button variant="ghost" size="sm" onClick={() => setRevoke({ id: token.id, label: token.label ?? 'personal token' })} aria-label={`Revoke ${token.label ?? 'personal token'}`}>Revoke</Button>}</TableCell>
            </TableRow>)}</TableBody>
          </Table></TableScroll>
        )}
      </Panel>
      {revealed && <OneTimeTokenReveal token={revealed} title="New personal token" onDismiss={() => setRevealed(null)} />}
      {revoke && <Confirm title="Revoke personal token" body={<>This token stops working immediately. Its masked audit record stays visible.</>} error={profileError ?? undefined} confirmLabel="Revoke token" tone="warn" onCancel={() => setRevoke(null)} onConfirm={revokeToken} />}
    </div>
  );
}
