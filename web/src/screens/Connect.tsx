import { useCallback, useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { Loader2 } from '@/components/icons';
import {
  hostedAuthConfig,
  hostedAuthEnabled,
  hostedAuthIncomplete,
  useHostedAuth,
  useHostedToken,
} from '../oidc';
import { ApiError } from '../api/client';
import { useStore } from '../store';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export function Connect() {
  if (hostedAuthEnabled) return <HostedConnect />;
  return <TokenConnect />;
}

export function HostedConnect() {
  const { connectHosted } = useStore();
  const { isAuthenticated, isLoading, login, logout, error } = useHostedAuth();
  const getToken = useHostedToken();
  const attempted = useRef(false);
  const [err, setErr] = useState<string | null>(null);
  const [needsReauthentication, setNeedsReauthentication] = useState(false);
  const [busy, setBusy] = useState(false);

  const connectWorkspace = useCallback(() => {
    if (attempted.current) return;
    attempted.current = true;
    setErr(null);
    setNeedsReauthentication(false);
    setBusy(true);
    void connectHosted({ baseUrl: hostedAuthConfig.apiUrl, getToken })
      .catch((ex) => {
        setErr(hostedConnectionError(ex));
        setNeedsReauthentication(hostedConnectionNeedsReauthentication(ex));
      })
      .finally(() => setBusy(false));
  }, [connectHosted, getToken]);

  useEffect(() => {
    if (isAuthenticated) {
      connectWorkspace();
      return;
    }
    attempted.current = false;
    setBusy(false);
    setErr(null);
    setNeedsReauthentication(false);
  }, [connectWorkspace, isAuthenticated]);

  const signIn = () => login();
  const signOutAndRetry = () => {
    attempted.current = false;
    setErr(null);
    void logout();
  };
  const retryConnection = () => {
    attempted.current = false;
    connectWorkspace();
  };

  if (isLoading || (isAuthenticated && !err)) {
    return <AuthBootShell />;
  }

  if (isAuthenticated && err) {
    return (
      <ConnectShell>
        <Brand />
        <h1 className="serif text-3xl">Workspace could not be restored.</h1>
        <p className="mt-2 mb-6 text-sm text-muted-foreground">
          Your identity is still protected. Retry the workspace connection or sign in again if the session has expired.
        </p>
        <Button
          className="h-10 w-full"
          onClick={needsReauthentication ? signOutAndRetry : retryConnection}
          disabled={busy}
        >
          {busy
            ? <Loader2 className="size-4 animate-spin" />
            : needsReauthentication
              ? 'Sign out and try again'
              : 'Try again'}
        </Button>
        <div className="mt-4 text-xs text-destructive" role="alert">{err}</div>
      </ConnectShell>
    );
  }

  return (
    <ConnectShell>
      <Brand />
      <h1 className="serif text-3xl">Sign in to your workspace.</h1>
      <p className="mt-2 mb-6 text-sm text-muted-foreground">
        Use hosted auth, then create an MCP token during onboarding. No database keys are needed in the browser.
      </p>
      <Button
        className="h-10 w-full"
        onClick={signIn}
        disabled={busy}
      >
        {busy
          ? <Loader2 className="size-4 animate-spin" />
          : 'Continue to sign in'}
      </Button>
      {error && <div className="mt-4 text-xs text-destructive" role="alert">{error.message}</div>}
    </ConnectShell>
  );
}

export function hostedConnectionError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401 || error.code === 'authentication_failed') {
      return 'Your sign-in session is unavailable or expired. Verify your email, then sign in again.';
    }
    if (error.status === 403) {
      return 'Your account is signed in but does not have access to this workspace.';
    }
  }
  return error instanceof Error ? error.message : 'The hosted sign-in could not be completed.';
}

function hostedConnectionNeedsReauthentication(error: unknown): boolean {
  return error instanceof ApiError
    && (error.status === 401 || error.code === 'authentication_failed');
}

function Brand() {
  return (
    <div className="mb-4 flex items-center gap-2.5">
      <img className="size-6" src="/poolstatis-logo.svg" alt="" />
      <span className="text-xs font-medium text-muted-foreground">Poolstatis · Hosted admin</span>
    </div>
  );
}

export function AuthBootShell() {
  return (
    <div
      className="min-h-screen bg-background"
      data-testid="auth-boot-shell"
      aria-busy="true"
    />
  );
}

function TokenConnect() {
  const { connect } = useStore();
  const [token, setToken] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const baseUrl = hostedAuthConfig.apiUrl;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null); setBusy(true);
    try { await connect({ baseUrl, token: token.trim() }); }
    catch (ex) { setErr((ex as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <ConnectShell>
      <div className="flex items-center gap-2.5 mb-4">
        <img className="size-6" src="/poolstatis-logo.svg" alt="" />
        <span className="text-xs font-medium text-muted-foreground">Poolstatis · Admin</span>
      </div>
      <h1 className="serif text-3xl">Connect the instrument.</h1>
      <p className="text-muted-foreground mt-2 mb-6 text-sm">
        {hostedAuthIncomplete
          ? 'Hosted auth is partially configured. Add the OIDC authority, client id, audience, and API URL to enable the sign-in flow.'
          : 'Hosted auth is not configured in this environment. Paste a personal token (pt_) or a project secret key (sk_) to continue.'}
      </p>
      <form onSubmit={submit} className="space-y-4">
        <div className="space-y-1.5">
          <Label className="text-xs font-medium text-muted-foreground">Token</Label>
          <Input type="password" placeholder="sk_... or pt_..." value={token} onChange={(e) => setToken(e.target.value)} autoFocus />
        </div>
        <Button type="submit" className="w-full" disabled={busy || !token}>{busy ? <Loader2 className="size-4 animate-spin" /> : 'Connect'}</Button>
        {err && <div className="text-destructive text-xs">{err}</div>}
      </form>
    </ConnectShell>
  );
}

function ConnectShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <motion.div initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, ease: 'easeOut' }} className="w-full max-w-md">
        <Card>
          <CardContent className="p-8">
            {children}
          </CardContent>
        </Card>
      </motion.div>
    </div>
  );
}
