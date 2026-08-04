import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
  type Ref,
} from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ArrowLeft, Eye, EyeOff } from '@/components/icons';
import authEvidenceInstrument from '@/assets/auth-evidence-instrument.jpg';

const authOrigin = 'https://auth.poolstatis.xyz';
const customerAppUrl = 'https://app.poolstatis.xyz/';
const neutralFailure = 'The request could not be completed. Check the details and try again.';
const loginAfterVerificationPath = '/login?verified=1&reauth=1';
export const verificationContinueUrl = `${authOrigin}${loginAfterVerificationPath}`;

type EmailProvider = {
  href: string;
  label: string;
};

const emailProviders: Record<string, EmailProvider> = {
  'yandex.ru': { href: 'https://mail.yandex.ru/', label: 'Open Yandex Mail' },
  'ya.ru': { href: 'https://mail.yandex.ru/', label: 'Open Yandex Mail' },
  'yandex.com': { href: 'https://mail.yandex.com/', label: 'Open Yandex Mail' },
  'gmail.com': { href: 'https://mail.google.com/', label: 'Open Gmail' },
  'googlemail.com': { href: 'https://mail.google.com/', label: 'Open Gmail' },
  'outlook.com': { href: 'https://outlook.live.com/mail/', label: 'Open Outlook' },
  'hotmail.com': { href: 'https://outlook.live.com/mail/', label: 'Open Outlook' },
  'live.com': { href: 'https://outlook.live.com/mail/', label: 'Open Outlook' },
  'mail.ru': { href: 'https://e.mail.ru/inbox/', label: 'Open Mail.ru' },
  'inbox.ru': { href: 'https://e.mail.ru/inbox/', label: 'Open Mail.ru' },
  'list.ru': { href: 'https://e.mail.ru/inbox/', label: 'Open Mail.ru' },
  'bk.ru': { href: 'https://e.mail.ru/inbox/', label: 'Open Mail.ru' },
};

export function emailProviderForAddress(email: string): EmailProvider | null {
  const separator = email.lastIndexOf('@');
  if (separator < 1) return null;
  return emailProviders[email.slice(separator + 1).trim().toLowerCase()] ?? null;
}

type ApiResult = Record<string, unknown>;
type VerificationState =
  | 'checking'
  | 'verified'
  | 'email_change_confirmed'
  | 'email_changed'
  | 'already_verified'
  | 'already_used'
  | 'invalid_or_expired'
  | 'temporarily_unavailable';

class AuthRequestError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterMs: number | null,
  ) {
    super(neutralFailure);
    this.name = 'AuthRequestError';
  }
}

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

export function authenticatedAppRedirect(result: ApiResult, search: string): string | null {
  if (signedOAuthQuery(search)) return null;
  if (
    !result.user
    || typeof result.user !== 'object'
    || !result.session
    || typeof result.session !== 'object'
  ) return null;
  return customerAppUrl;
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
  if (!response.ok) {
    const retryAfter = Number(response.headers.get('retry-after'));
    throw new AuthRequestError(
      response.status,
      Number.isFinite(retryAfter) && retryAfter >= 0 && retryAfter <= 5
        ? retryAfter * 1_000
        : null,
    );
  }
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
    <div className="min-h-dvh bg-background text-foreground lg:grid lg:grid-cols-5">
      <section
        aria-label="Why Poolstatis"
        className="relative hidden min-h-dvh overflow-hidden border-r lg:col-span-3 lg:flex lg:flex-col"
      >
        <div
          className="absolute inset-x-0 top-1/2 aspect-video -translate-y-1/2 bg-cover bg-center opacity-90"
          aria-hidden="true"
          style={{ backgroundImage: `url(${authEvidenceInstrument})` }}
        />
        <div className="absolute inset-0 bg-gradient-to-b from-background/20 via-transparent to-background" />
        <div className="absolute inset-0 bg-gradient-to-r from-background/70 via-background/10 to-transparent" />
        <div className="relative z-10 flex h-full flex-col justify-between p-10 xl:p-14">
          <a
            href="https://poolstatis.xyz/"
            className="inline-flex w-fit items-center gap-2.5 rounded-md focus-visible:ring-2 focus-visible:ring-ring"
          >
            <img className="size-8" src="/poolstatis-logo.svg" alt="" width="32" height="32" />
            <span className="text-lg font-bold">Poolstatis</span>
          </a>
          <div className="max-w-xl pb-4">
            <p className="text-sm font-medium text-primary">Product decisions, backed by real signals</p>
            <p className="mt-4 text-5xl font-semibold leading-tight xl:text-6xl">
              See the signals behind every product decision.
            </p>
            <p className="mt-5 max-w-lg text-lg text-foreground/70">
              Evidence for your next keep, fix, or roll back decision.
            </p>
          </div>
        </div>
      </section>

      <div className="flex min-h-dvh flex-col lg:col-span-2">
        <header className="flex items-center justify-between px-6 py-5 lg:px-8">
          <a
            href="https://poolstatis.xyz/"
            className="inline-flex items-center gap-2 rounded-md text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ArrowLeft className="size-4" /> Back to home
          </a>
          <a href="https://poolstatis.xyz/" className="inline-flex items-center gap-2 lg:hidden">
            <img className="size-7" src="/poolstatis-logo.svg" alt="" width="28" height="28" />
            <span className="font-semibold">Poolstatis</span>
          </a>
        </header>
        <main className="grid flex-1 place-items-center px-6 py-10 lg:px-8">
          <div className="w-full max-w-sm">
            {children}
            <p className="mt-7 text-xs leading-5 text-muted-foreground">
              Your password stays with the Poolstatis identity service.
            </p>
          </div>
        </main>
      </div>
    </div>
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
  const isPassword = type === 'password';
  const [passwordVisible, setPasswordVisible] = useState(false);

  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      <div className="relative">
        <Input
          id={id}
          name={id}
          type={isPassword && passwordVisible ? 'text' : type}
          autoComplete={autoComplete}
          value={value}
          minLength={minLength}
          maxLength={isPassword ? 128 : 254}
          required
          className={isPassword ? 'pr-11' : undefined}
          onChange={(event) => onChange(event.target.value)}
        />
        {isPassword && (
          <span className="absolute inset-y-0 right-1 flex items-center">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground hover:text-foreground"
              aria-label={passwordVisible ? 'Hide password' : 'Show password'}
              aria-controls={id}
              aria-pressed={passwordVisible}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => setPasswordVisible((visible) => !visible)}
            >
              {passwordVisible
                ? <EyeOff className="size-4" aria-hidden="true" />
                : <Eye className="size-4" aria-hidden="true" />}
            </Button>
          </span>
        )}
      </div>
    </div>
  );
}

function AuthCard({
  title,
  description,
  children,
  titleRef,
}: {
  title: string;
  description: string;
  children: ReactNode;
  titleRef?: Ref<HTMLHeadingElement>;
}) {
  return (
    <section>
      <p className="text-sm font-medium text-primary">Poolstatis Cloud · beta</p>
      <h1
        ref={titleRef}
        tabIndex={titleRef ? -1 : undefined}
        className="serif mt-3 text-4xl font-normal leading-tight outline-none"
      >
        {title}
      </h1>
      <p className="mt-3 mb-7 text-sm leading-6 text-muted-foreground">{description}</p>
      {children}
    </section>
  );
}

function FormMessage({ error, message }: { error: string; message: string }) {
  if (!error && !message) return null;
  return (
    <p
      role={error ? 'alert' : 'status'}
      aria-live={error ? 'assertive' : 'polite'}
      className={error ? 'text-sm text-destructive' : 'text-sm text-emerald-400'}
    >
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
  const oauthQuery = useMemo(() => signedOAuthQuery(search), [search]);
  const forceReauthentication = query.get('reauth') === '1';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [sessionChecked, setSessionChecked] = useState(
    Boolean(oauthQuery) && !forceReauthentication,
  );
  const [sessionError, setSessionError] = useState('');
  const submission = useSubmission();
  const callbackURL = safeAuthCallback('/login', search);

  useEffect(() => {
    let live = true;
    if (forceReauthentication) {
      void authPost('/sign-out', {})
        .catch(() => {
          if (live) setSessionError(neutralFailure);
        })
        .finally(() => {
          if (live) setSessionChecked(true);
        });
      return () => { live = false; };
    }
    if (oauthQuery) {
      setSessionChecked(true);
      return;
    }
    void authGet('/get-session')
      .then((result) => {
        if (!live) return;
        const destination = authenticatedAppRedirect(result, search);
        if (destination) {
          window.location.replace(destination);
          return;
        }
        setSessionChecked(true);
      })
      .catch(() => {
        if (live) setSessionChecked(true);
      });
    return () => { live = false; };
  }, [forceReauthentication, oauthQuery, search]);

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
        window.location.assign(customerAppUrl);
      }
    });
  };

  if (!sessionChecked) {
    return <div className="h-80" data-testid="auth-session-check" aria-busy="true" />;
  }

  return (
    <AuthCard title="Welcome back" description="Sign in to continue to your Poolstatis workspace.">
      <form className="grid gap-4" onSubmit={submit}>
        <Field id="email" label="Email" type="email" autoComplete="email" value={email} onChange={setEmail} />
        <Field id="password" label="Password" type="password" autoComplete="current-password" value={password} onChange={setPassword} minLength={12} />
        <FormMessage
          error={submission.error || sessionError || (query.has('error') ? neutralFailure : '')}
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
  const [completedEmail, setCompletedEmail] = useState('');
  const submission = useSubmission();
  const callbackParams = new URLSearchParams(signedOAuthQuery(search));
  callbackParams.set('verified', '1');
  callbackParams.set('reauth', '1');
  const callbackURL = safeAuthCallback('/login', `?${callbackParams.toString()}`);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void submission.run(async () => {
      const signupEmail = email.trim();
      await authPost('/sign-out', {});
      await authPost('/sign-up/email', {
        name: name.trim(),
        email: signupEmail,
        password,
        callbackURL,
        ...oauthBody(search),
      });
      setPassword('');
      setCompletedEmail(signupEmail);
    });
  };
  if (completedEmail) {
    const provider = emailProviderForAddress(completedEmail);
    return (
      <AuthCard
        title="Check your inbox"
        description={`We sent a verification link to ${completedEmail}. Open it before signing in.`}
      >
        <div className="grid gap-3">
          {provider && (
            <Button asChild>
              <a href={provider.href} target="_blank" rel="noreferrer">{provider.label}</a>
            </Button>
          )}
          {!provider && (
            <p className="text-sm text-muted-foreground">Open your email provider to find the verification message.</p>
          )}
          <Button asChild variant="outline">
            <Link to={loginAfterVerificationPath}>Already verified? Sign in</Link>
          </Button>
          <button
            type="button"
            className="mt-1 text-sm text-muted-foreground hover:text-foreground"
            onClick={() => setCompletedEmail('')}
          >
            Use a different email
          </button>
        </div>
      </AuthCard>
    );
  }
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
          <p className="text-sm text-destructive">This reset link is invalid or expired.</p>
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

function verificationState(value: string | null): VerificationState | null {
  if (
    value === 'verified'
    || value === 'email_change_confirmed'
    || value === 'email_changed'
    || value === 'already_verified'
    || value === 'already_used'
    || value === 'invalid_or_expired'
  ) return value;
  return null;
}

function ResendVerification() {
  const [email, setEmail] = useState('');
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<'idle' | 'accepted' | 'throttled' | 'error'>('idle');
  const outcomeRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (outcome !== 'idle') outcomeRef.current?.focus();
  }, [outcome]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setOutcome('idle');
    void authPost('/send-verification-email', {
      email,
      callbackURL: safeAuthCallback('/verify'),
    }).then(() => {
      setEmail('');
      setOutcome('accepted');
    }).catch((error: unknown) => {
      setOutcome(error instanceof AuthRequestError && error.status === 429 ? 'throttled' : 'error');
    }).finally(() => setPending(false));
  };
  const message = outcome === 'accepted'
    ? 'If an unverified account exists, a new verification email is on its way.'
    : outcome === 'throttled'
      ? 'Please wait before requesting another verification email.'
      : outcome === 'error'
        ? neutralFailure
        : '';
  return (
    <form className="grid gap-4 border-t pt-5" onSubmit={submit}>
      <p className="text-sm text-muted-foreground">
        Enter the account email. The response is the same whether or not an account exists.
      </p>
      <Field id="verification-email" label="Email" type="email" autoComplete="email" value={email} onChange={setEmail} />
      {message && (
        <p
          ref={outcomeRef}
          tabIndex={-1}
          role={outcome === 'error' ? 'alert' : 'status'}
          aria-live={outcome === 'error' ? 'assertive' : 'polite'}
          className={outcome === 'error' ? 'text-sm text-destructive' : 'text-sm text-emerald-400 outline-none'}
        >
          {message}
        </p>
      )}
      <Button disabled={pending} type="submit">
        {pending ? 'Sending…' : 'Send a new verification email'}
      </Button>
    </form>
  );
}

function VerificationResult() {
  const { search, hash } = useLocation();
  const queryState = verificationState(new URLSearchParams(search).get('state'));
  const token = useMemo(
    () => new URLSearchParams(hash.replace(/^#/, '')).get('token') ?? '',
    [hash],
  );
  const [state, setState] = useState<VerificationState>(
    queryState ?? (token ? 'checking' : 'invalid_or_expired'),
  );
  const headingRef = useRef<HTMLHeadingElement>(null);
  const exchangeStartedRef = useRef(false);

  const exchangeVerification = () => {
    setState('checking');
    void (async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const result = await authPost('/poolstatis/verify-email', { token });
          const next = verificationState(typeof result.state === 'string' ? result.state : null);
          setState(next ?? 'invalid_or_expired');
          return;
        } catch (error) {
          if (
            error instanceof AuthRequestError
            && error.status === 429
          ) {
            if (attempt < 2) {
              await new Promise((resolve) => window.setTimeout(
                resolve,
                error.retryAfterMs ?? 1_000,
              ));
              continue;
            }
            setState('temporarily_unavailable');
            return;
          }
          setState('invalid_or_expired');
          return;
        }
      }
    })();
  };

  useEffect(() => {
    if (queryState || !token || exchangeStartedRef.current) return;
    exchangeStartedRef.current = true;
    window.history.replaceState({}, document.title, '/verify');
    exchangeVerification();
  }, [queryState, token]);

  useEffect(() => {
    if (state === 'checking') return;
    headingRef.current?.focus();
    if (state !== 'verified' && state !== 'email_changed') return;
    const timer = window.setTimeout(() => {
      window.location.assign(verificationContinueUrl);
    }, 2_000);
    return () => window.clearTimeout(timer);
  }, [state]);

  const content = {
    verified: {
      title: 'Email verified',
      description: 'Your identity is confirmed. Redirecting you to sign in…',
    },
    email_change_confirmed: {
      title: 'Email change confirmed',
      description: 'Check the new address to finish updating your Poolstatis account.',
    },
    email_changed: {
      title: 'Email updated',
      description: 'Your new address is verified. Redirecting you to sign in…',
    },
    already_verified: {
      title: 'Email already verified',
      description: 'This account is already confirmed. You can continue to sign in.',
    },
    already_used: {
      title: 'Verification link already used',
      description: 'This one-time link cannot be used again. Sign in or request a fresh email if needed.',
    },
    invalid_or_expired: {
      title: 'Verification link expired or invalid',
      description: 'The link could not be accepted. Request a fresh email or return to sign in.',
    },
    temporarily_unavailable: {
      title: 'Verification is temporarily unavailable',
      description: 'Your link was not rejected. Wait a moment, then try the same link again.',
    },
  }[state === 'checking' ? 'invalid_or_expired' : state];

  return (
    <AuthCard
      title={state === 'checking' ? 'Checking your verification link' : content.title}
      description={state === 'checking' ? 'This will only take a moment.' : content.description}
      titleRef={headingRef}
    >
      {state === 'checking' ? (
        <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
          Verifying…
        </p>
      ) : (
        <div className="grid gap-4">
          <Button asChild>
            <a href={verificationContinueUrl}>Continue and sign in</a>
          </Button>
          {state === 'temporarily_unavailable' && (
            <Button type="button" variant="outline" onClick={exchangeVerification}>
              Try verification again
            </Button>
          )}
          {(state === 'invalid_or_expired' || state === 'already_used') && <ResendVerification />}
          <div className="flex justify-between gap-4 text-sm">
            <Link className="text-muted-foreground hover:text-foreground" to="/login">Back to sign in</Link>
            <Link className="text-muted-foreground hover:text-foreground" to="/signup">Create account</Link>
          </div>
        </div>
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
    return <AuthCard title="Account" description="Loading your identity…"><div className="h-9 animate-pulse rounded-md bg-muted" /></AuthCard>;
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
  let content: ReactNode;
  if (pathname === '/signup') content = <Signup />;
  else if (pathname === '/forgot') content = <ForgotPassword />;
  else if (pathname === '/reset') content = <ResetPassword />;
  else if (pathname === '/verify') content = <VerificationResult />;
  else if (pathname === '/consent') content = <Consent />;
  else if (pathname === '/profile') content = (
    <>
      <a
        href="https://app.poolstatis.xyz/profile"
        className="mb-3 inline-flex w-fit items-center gap-2 rounded-sm text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ArrowLeft className="size-4" />Back to Poolstatis
      </a>
      <AccountProfile />
    </>
  );
  else content = <Login />;
  return <AuthShell>{content}</AuthShell>;
}
