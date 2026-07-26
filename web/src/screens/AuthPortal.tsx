import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const authOrigin = 'https://auth.poolstatis.xyz';
const neutralFailure = 'The request could not be completed. Check the details and try again.';

type ApiResult = Record<string, unknown>;

export function signedOAuthQuery(search: string): string | undefined {
  const params = new URLSearchParams(search);
  if (!params.has('sig')) return undefined;
  const signedNames = new Set(params.getAll('ba_param'));
  if (signedNames.size === 0) return undefined;
  const signed = new URLSearchParams();
  for (const [key, value] of params) {
    if (key === 'sig' || key === 'ba_param' || signedNames.has(key)) {
      signed.append(key, value);
    }
  }
  return signed.toString();
}

function safeAuthCallback(path: string, search = ''): string {
  const url = new URL(path, authOrigin);
  if (url.origin !== authOrigin) throw new Error('invalid authentication callback');
  url.search = search;
  return url.toString();
}

export function approvedOAuthRedirect(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.origin !== 'https://app.poolstatis.xyz') return null;
    if (url.pathname !== '/' && url.pathname !== '/operator/') return null;
    return url.toString();
  } catch {
    return null;
  }
}

async function authPost(path: string, body: Record<string, unknown>): Promise<ApiResult> {
  const response = await fetch(`/api/auth${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({})) as ApiResult;
  if (!response.ok) throw new Error(neutralFailure);
  return result;
}

async function authGet(path: string): Promise<ApiResult> {
  const response = await fetch(`/api/auth${path}`, {
    credentials: 'include',
    headers: { accept: 'application/json' },
  });
  const result = await response.json().catch(() => ({})) as ApiResult;
  if (!response.ok) throw new Error(neutralFailure);
  return result;
}

function AuthShell({ children }: { children: ReactNode }) {
  return (
    <main className="relative min-h-screen overflow-hidden bg-background px-4 py-10 sm:px-6">
      <div aria-hidden className="pointer-events-none absolute inset-0 opacity-50 [background-image:radial-gradient(circle_at_center,oklch(0.7_0.1_260/.22)_1px,transparent_1px)] [background-size:28px_28px]" />
      <div className="relative mx-auto flex min-h-[calc(100vh-5rem)] max-w-md flex-col justify-center">
        <Link to="/login" className="mb-7 flex w-fit items-center gap-3">
          <img className="size-10" src="/poolstatis-logo.svg" alt="" />
          <span className="brand-wordmark text-2xl">Poolstatis</span>
        </Link>
        {children}
        <p className="mt-6 text-xs leading-5 text-muted-foreground">
          Your password is handled only by the Poolstatis identity service.
          Analytics projects and organizations remain separate from your login.
        </p>
      </div>
    </main>
  );
}

function Field({
  id,
  label,
  type = 'text',
  autoComplete,
  value,
  onChange,
  minLength,
}: {
  id: string;
  label: string;
  type?: string;
  autoComplete?: string;
  value: string;
  onChange(value: string): void;
  minLength?: number;
}) {
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        name={id}
        type={type}
        autoComplete={autoComplete}
        value={value}
        minLength={minLength}
        maxLength={type === 'password' ? 128 : 254}
        required
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

function AuthCard({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <Card className="gap-0 overflow-hidden border-border/80 bg-card/95 py-0 shadow-2xl shadow-black/20 backdrop-blur">
      <div className="h-1 bg-gradient-to-r from-sky-400 via-indigo-400 to-violet-400" />
      <CardHeader className="px-6 pb-5 pt-6">
        <h1 className="serif text-3xl font-normal leading-tight">{title}</h1>
        <CardDescription className="leading-6">{description}</CardDescription>
      </CardHeader>
      <CardContent className="px-6 pb-6">{children}</CardContent>
    </Card>
  );
}

function FormMessage({ error, message }: { error: string; message: string }) {
  if (!error && !message) return null;
  return (
    <p role={error ? 'alert' : 'status'} className={error ? 'text-sm text-destructive' : 'text-sm text-emerald-400'}>
      {error || message}
    </p>
  );
}

function useSubmission() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const run = async (operation: () => Promise<void>) => {
    if (pending) return;
    setPending(true);
    setError('');
    setMessage('');
    try {
      await operation();
    } catch {
      setError(neutralFailure);
    } finally {
      setPending(false);
    }
  };
  return { pending, error, message, setMessage, run };
}

function oauthBody(search: string): { oauth_query?: string } {
  const oauthQuery = signedOAuthQuery(search);
  return oauthQuery ? { oauth_query: oauthQuery } : {};
}

function redirectResult(result: ApiResult): boolean {
  const redirect = approvedOAuthRedirect(result.redirect_uri ?? result.url);
  if (!redirect) return false;
  window.location.assign(redirect);
  return true;
}

function Login() {
  const { search } = useLocation();
  const query = useMemo(() => new URLSearchParams(search), [search]);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const submission = useSubmission();
  const callbackURL = safeAuthCallback('/login', search);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void submission.run(async () => {
      const result = await authPost('/sign-in/email', {
        email,
        password,
        rememberMe: true,
        callbackURL,
        ...oauthBody(search),
      });
      if (!redirectResult(result)) {
        window.location.assign('https://app.poolstatis.xyz/');
      }
    });
  };
  return (
    <AuthCard title="Welcome back" description="Sign in to continue to your Poolstatis workspace.">
      <form className="grid gap-4" onSubmit={submit}>
        <Field id="email" label="Email" type="email" autoComplete="email" value={email} onChange={setEmail} />
        <Field id="password" label="Password" type="password" autoComplete="current-password" value={password} onChange={setPassword} minLength={12} />
        <FormMessage
          error={submission.error || (query.has('error') ? neutralFailure : '')}
          message={
            submission.message
            || (query.has('verified') ? 'Email verified. You can sign in now.' : '')
            || (query.has('reset') ? 'Password updated. Sign in with the new password.' : '')
          }
        />
        <Button disabled={submission.pending} type="submit">{submission.pending ? 'Signing in…' : 'Sign in'}</Button>
        <div className="flex justify-between gap-4 text-sm">
          <Link className="text-muted-foreground hover:text-foreground" to={`/forgot${search}`}>Forgot password?</Link>
          <Link className="text-muted-foreground hover:text-foreground" to={`/signup${search}`}>Create account</Link>
        </div>
      </form>
    </AuthCard>
  );
}

function Signup() {
  const { search } = useLocation();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const submission = useSubmission();
  const callbackURL = safeAuthCallback('/login', `?verified=1&${search.replace(/^\?/, '')}`);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void submission.run(async () => {
      await authPost('/sign-up/email', {
        name,
        email,
        password,
        callbackURL,
        ...oauthBody(search),
      });
      setPassword('');
      submission.setMessage('Check your email to verify the account, then sign in.');
    });
  };
  return (
    <AuthCard title="Create your account" description="Verify your email before creating a Poolstatis workspace.">
      <form className="grid gap-4" onSubmit={submit}>
        <Field id="name" label="Name" autoComplete="name" value={name} onChange={setName} />
        <Field id="email" label="Email" type="email" autoComplete="email" value={email} onChange={setEmail} />
        <Field id="password" label="Password" type="password" autoComplete="new-password" value={password} onChange={setPassword} minLength={12} />
        <p className="text-xs text-muted-foreground">Use at least 12 characters.</p>
        <FormMessage error={submission.error} message={submission.message} />
        <Button disabled={submission.pending} type="submit">{submission.pending ? 'Creating…' : 'Create account'}</Button>
        <Link className="text-center text-sm text-muted-foreground hover:text-foreground" to={`/login${search}`}>Already have an account?</Link>
      </form>
    </AuthCard>
  );
}

function ForgotPassword() {
  const [email, setEmail] = useState('');
  const submission = useSubmission();
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void submission.run(async () => {
      await authPost('/request-password-reset', {
        email,
        redirectTo: safeAuthCallback('/reset'),
      });
      submission.setMessage('If the account exists, a reset link is on its way.');
    });
  };
  return (
    <AuthCard title="Reset your password" description="Enter your email. The response is the same for every account.">
      <form className="grid gap-4" onSubmit={submit}>
        <Field id="email" label="Email" type="email" autoComplete="email" value={email} onChange={setEmail} />
        <FormMessage error={submission.error} message={submission.message} />
        <Button disabled={submission.pending} type="submit">{submission.pending ? 'Sending…' : 'Send reset link'}</Button>
        <Link className="text-center text-sm text-muted-foreground hover:text-foreground" to="/login">Back to sign in</Link>
      </form>
    </AuthCard>
  );
}

function ResetPassword() {
  const { search } = useLocation();
  const navigate = useNavigate();
  const token = useMemo(() => new URLSearchParams(search).get('token') ?? '', [search]);
  const invalid = Boolean(new URLSearchParams(search).get('error')) || token.length < 8;
  const [password, setPassword] = useState('');
  const submission = useSubmission();
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void submission.run(async () => {
      await authPost('/reset-password', { newPassword: password, token });
      setPassword('');
      navigate('/login?reset=1', { replace: true });
    });
  };
  return (
    <AuthCard title="Choose a new password" description="Reset links expire after one hour and can be used once.">
      {invalid ? (
        <div className="grid gap-4">
          <p role="alert" className="text-sm text-destructive">This reset link is invalid or expired.</p>
          <Link className="text-sm text-muted-foreground hover:text-foreground" to="/forgot">Request a new link</Link>
        </div>
      ) : (
        <form className="grid gap-4" onSubmit={submit}>
          <Field id="password" label="New password" type="password" autoComplete="new-password" value={password} onChange={setPassword} minLength={12} />
          <FormMessage error={submission.error} message={submission.message} />
          <Button disabled={submission.pending} type="submit">{submission.pending ? 'Updating…' : 'Update password'}</Button>
        </form>
      )}
    </AuthCard>
  );
}

function Consent() {
  const { search } = useLocation();
  const submission = useSubmission();
  const decide = (accept: boolean) => {
    void submission.run(async () => {
      const result = await authPost('/oauth2/consent', {
        accept,
        ...oauthBody(search),
      });
      if (!redirectResult(result)) throw new Error('invalid OAuth response');
    });
  };
  return (
    <AuthCard title="Continue to Poolstatis" description="The application is requesting access to your profile and workspace API.">
      <div className="grid gap-4">
        <ul className="grid gap-2 text-sm text-muted-foreground">
          <li>Read your verified identity and profile.</li>
          <li>Access Poolstatis on your behalf.</li>
          <li>Keep the session until you sign out.</li>
        </ul>
        <FormMessage error={submission.error} message={submission.message} />
        <div className="grid grid-cols-2 gap-3">
          <Button variant="outline" disabled={submission.pending} onClick={() => decide(false)}>Cancel</Button>
          <Button disabled={submission.pending} onClick={() => decide(true)}>Continue</Button>
        </div>
      </div>
    </AuthCard>
  );
}

function AccountProfile() {
  const [user, setUser] = useState<{ name: string; email: string } | null>(null);
  const [name, setName] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [loadError, setLoadError] = useState('');
  const profile = useSubmission();
  const email = useSubmission();
  const password = useSubmission();

  useEffect(() => {
    let live = true;
    void authGet('/get-session').then((result) => {
      const candidate = result.user as { name?: unknown; email?: unknown } | undefined;
      if (!live) return;
      if (!candidate || typeof candidate.name !== 'string' || typeof candidate.email !== 'string') {
        setLoadError('Sign in again to manage your account.');
        return;
      }
      setUser({ name: candidate.name, email: candidate.email });
      setName(candidate.name);
    }).catch(() => {
      if (live) setLoadError('Sign in again to manage your account.');
    });
    return () => { live = false; };
  }, []);

  if (loadError) {
    return (
      <AuthCard title="Account" description="Manage the identity used for Poolstatis.">
        <div className="grid gap-4">
          <p className="text-sm text-muted-foreground">{loadError}</p>
          <Button asChild><Link to="/login">Sign in</Link></Button>
        </div>
      </AuthCard>
    );
  }
  if (!user) {
    return <AuthCard title="Account" description="Loading your identity…"><div role="status" aria-label="Loading account" className="h-9 animate-pulse rounded-md bg-muted" /></AuthCard>;
  }
  return (
    <AuthCard title="Your account" description={`${user.email} · verified identity`}>
      <div className="grid gap-7">
        <form className="grid gap-3" onSubmit={(event) => {
          event.preventDefault();
          void profile.run(async () => {
            await authPost('/update-user', { name });
            setUser((current) => current ? { ...current, name } : current);
            profile.setMessage('Name updated.');
          });
        }}>
          <Field id="name" label="Display name" autoComplete="name" value={name} onChange={setName} />
          <FormMessage error={profile.error} message={profile.message} />
          <Button variant="outline" disabled={profile.pending} type="submit">Save name</Button>
        </form>
        <form className="grid gap-3 border-t pt-6" onSubmit={(event) => {
          event.preventDefault();
          void email.run(async () => {
            await authPost('/change-email', {
              newEmail,
              callbackURL: safeAuthCallback('/profile'),
            });
            setNewEmail('');
            email.setMessage('Check your inbox to confirm the email change.');
          });
        }}>
          <Field id="new-email" label="New email" type="email" autoComplete="email" value={newEmail} onChange={setNewEmail} />
          <FormMessage error={email.error} message={email.message} />
          <Button variant="outline" disabled={email.pending} type="submit">Change email</Button>
        </form>
        <form className="grid gap-3 border-t pt-6" onSubmit={(event) => {
          event.preventDefault();
          void password.run(async () => {
            await authPost('/change-password', {
              currentPassword,
              newPassword,
              revokeOtherSessions: true,
            });
            setCurrentPassword('');
            setNewPassword('');
            password.setMessage('Password updated. Other sessions were signed out.');
          });
        }}>
          <Field id="current-password" label="Current password" type="password" autoComplete="current-password" value={currentPassword} onChange={setCurrentPassword} minLength={12} />
          <Field id="new-password" label="New password" type="password" autoComplete="new-password" value={newPassword} onChange={setNewPassword} minLength={12} />
          <FormMessage error={password.error} message={password.message} />
          <Button variant="outline" disabled={password.pending} type="submit">Change password</Button>
        </form>
      </div>
    </AuthCard>
  );
}

export function AuthPortal() {
  const { pathname } = useLocation();
  const pageTitle = pathname === '/signup' ? 'Create account'
    : pathname === '/forgot' ? 'Forgot password'
      : pathname === '/reset' ? 'Reset password'
        : pathname === '/consent' ? 'Authorize access'
          : pathname === '/profile' ? 'Account'
            : 'Sign in';
  useEffect(() => {
    document.title = `${pageTitle} — Poolstatis`;
  }, [pageTitle]);
  let content: ReactNode;
  if (pathname === '/signup') content = <Signup />;
  else if (pathname === '/forgot') content = <ForgotPassword />;
  else if (pathname === '/reset') content = <ResetPassword />;
  else if (pathname === '/consent') content = <Consent />;
  else if (pathname === '/profile') content = <AccountProfile />;
  else content = <Login />;
  return <AuthShell>{content}</AuthShell>;
}
