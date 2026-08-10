import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  approvedGoogleRedirect,
  approvedOAuthRedirect,
  AuthPortal,
  authenticatedAppRedirect,
  emailProviderForAddress,
  lastSignInMethod,
  signedOAuthQuery,
  verificationContinueUrl,
} from './screens/AuthPortal';

function renderPortal(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthPortal />
    </MemoryRouter>,
  );
}

describe('Better Auth portal', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.stubEnv('VITE_GOOGLE_AUTH_ENABLED', 'true');
    vi.useRealTimers();
    document.cookie = 'poolstatis.last_sign_in_method=; Max-Age=0; path=/';
  });

  it('forwards only provider-signed OAuth parameters', () => {
    const search = '?client_id=customer&redirect_uri=https%3A%2F%2Fapp.poolstatis.xyz%2F'
      + '&attacker=drop-me&sig=signed&ba_iat=123'
      + '&ba_param=client_id&ba_param=redirect_uri&ba_param=ba_iat&ba_param=ba_param';
    const result = new URLSearchParams(signedOAuthQuery(search));
    expect(result.get('client_id')).toBe('customer');
    expect(result.get('redirect_uri')).toBe('https://app.poolstatis.xyz/');
    expect(result.get('sig')).toBe('signed');
    expect(result.get('attacker')).toBeNull();
  });

  it('accepts only exact customer and operator callbacks', () => {
    expect(approvedOAuthRedirect('https://app.poolstatis.xyz/')).toBe('https://app.poolstatis.xyz/');
    expect(approvedOAuthRedirect('https://app.poolstatis.xyz/operator/')).toBe('https://app.poolstatis.xyz/operator/');
    expect(approvedOAuthRedirect('https://app.poolstatis.xyz/operator/extra')).toBeNull();
    expect(approvedOAuthRedirect('https://evil.test/')).toBeNull();
  });

  it('accepts only the exact Google authorization origin', () => {
    expect(approvedGoogleRedirect(
      'https://accounts.google.com/o/oauth2/v2/auth?client_id=public-client',
    )).toContain('https://accounts.google.com/o/oauth2/v2/auth');
    expect(approvedGoogleRedirect('https://accounts.google.com.evil.test/oauth')).toBeNull();
    expect(approvedGoogleRedirect('http://accounts.google.com/oauth')).toBeNull();
    expect(approvedGoogleRedirect('https://evil.test/oauth')).toBeNull();
  });

  it('reads only supported successful sign-in methods from the browser cookie', () => {
    expect(lastSignInMethod('theme=light; poolstatis.last_sign_in_method=google')).toBe('google');
    expect(lastSignInMethod('poolstatis.last_sign_in_method=email')).toBe('email');
    expect(lastSignInMethod('poolstatis.last_sign_in_method=github')).toBeNull();
    expect(lastSignInMethod('poolstatis.last_sign_in_method=%E0%A4%A')).toBeNull();
  });

  it('continues a saved direct session to the customer app but preserves signed OAuth', () => {
    const session = { user: { id: 'user-1' }, session: { id: 'session-1' } };
    expect(authenticatedAppRedirect(session, '')).toBe('https://app.poolstatis.xyz/');
    expect(authenticatedAppRedirect(
      session,
      '?sig=signed&ba_param=client_id&ba_param=ba_param&client_id=customer',
    )).toBeNull();
    expect(authenticatedAppRedirect({ user: null, session: null }, '')).toBeNull();
  });

  it('uses the same 3D split shell for sign in and account creation', () => {
    renderPortal('/signup');

    expect(screen.getByRole('region', { name: 'Why Poolstatis' })).toHaveClass('bg-primary', 'text-primary-foreground');
    expect(screen.getByText('See the signals behind every product decision.')).toBeInTheDocument();
    const cloudBeta = screen.getByText('Poolstatis Cloud · beta');
    expect(cloudBeta).toHaveClass('text-foreground');
    expect(cloudBeta).not.toHaveClass('text-brand-strong');
    expect(cloudBeta.querySelector('.bg-brand')).not.toBeNull();
    expect(screen.getByText('See the signals behind every product decision.')).toHaveClass('auth-display');
    expect(screen.getByRole('heading', { name: 'Create your account' })).toHaveClass('auth-display');
    expect(screen.getByRole('heading', { name: 'Create your account' })).not.toHaveClass('serif');
    expect(screen.getByRole('button', { name: 'Continue with Google' })).toBeInTheDocument();
  });

  it('hides unavailable social authentication without breaking email signup', async () => {
    vi.stubEnv('VITE_GOOGLE_AUTH_ENABLED', 'false');

    renderPortal('/signup');

    expect(screen.queryByRole('button', { name: /Continue with Google/ })).not.toBeInTheDocument();
    expect(screen.queryByText('or')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create account' })).toBeInTheDocument();
  });

  it('puts Google before the email form and marks the successful browser method', async () => {
    document.cookie = 'poolstatis.last_sign_in_method=google; path=/';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ user: null, session: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    renderPortal('/login');

    const google = await screen.findByRole('button', {
      name: 'Continue with Google, last used',
    });
    const email = screen.getByLabelText('Email');
    expect(google.compareDocumentPosition(email) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText('Last used')).toBeInTheDocument();
    expect(screen.getByText('Email and password')).toBeInTheDocument();
  });

  it('marks email and password when that was the last successful method', async () => {
    document.cookie = 'poolstatis.last_sign_in_method=email; path=/';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ user: null, session: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    renderPortal('/login');

    await screen.findByRole('button', { name: 'Continue with Google' });
    const emailMethod = screen.getByText('Email and password').parentElement;
    expect(emailMethod).toHaveTextContent('Email and passwordLast used');
  });

  it('shows the last successful method on account creation too', () => {
    document.cookie = 'poolstatis.last_sign_in_method=google; path=/';
    renderPortal('/signup');

    expect(screen.getByRole('button', {
      name: 'Continue with Google, last used',
    })).toBeInTheDocument();
    expect(screen.getByText('Email and password')).toBeInTheDocument();
  });

  it('keeps provider failures neutral, keyboard reachable, and out of browser history', async () => {
    const replaceState = vi.spyOn(window.history, 'replaceState');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ user: null, session: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    renderPortal(
      '/login?error=access_denied&error_description=provider-detail'
      + '&sig=signed&ba_iat=123&ba_param=client_id&ba_param=ba_iat'
      + '&ba_param=ba_param&client_id=customer&attacker=drop-me',
    );

    const google = await screen.findByRole('button', { name: 'Continue with Google' });
    expect(screen.getByRole('alert')).toHaveTextContent(
      'The request could not be completed. Check the details and try again.',
    );
    await waitFor(() => expect(replaceState).toHaveBeenCalledOnce());
    const cleanURL = String(replaceState.mock.calls.at(-1)?.[2]);
    expect(cleanURL).toMatch(/^\/login\?[^#]+$/);
    expect(cleanURL).toContain('sig=signed');
    expect(cleanURL).not.toContain('error');
    expect(cleanURL).not.toContain('provider-detail');
    expect(cleanURL).not.toContain('attacker');
    google.focus();
    expect(google).toHaveFocus();
  });

  it('starts one signed Google flow and preserves the outer OAuth transaction', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockReturnValue(new Promise(() => undefined));
    renderPortal(
      '/login?sig=signed&ba_iat=123&ba_param=client_id&ba_param=ba_iat'
      + '&ba_param=ba_param&client_id=customer&attacker=drop-me',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Continue with Google' }));
    const pending = await screen.findByRole('button', { name: 'Connecting…' });
    expect(pending).toBeDisabled();
    fireEvent.click(pending);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, request] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/auth/sign-in/social');
    const body = JSON.parse(String(request?.body));
    expect(body).toMatchObject({
      provider: 'google',
      requestSignUp: false,
      callbackURL: expect.stringContaining('https://auth.poolstatis.xyz/login?'),
      errorCallbackURL: expect.stringContaining('https://auth.poolstatis.xyz/login?'),
      oauth_query: expect.stringContaining('sig=signed'),
    });
    expect(body.callbackURL).not.toContain('attacker');
    expect(body.errorCallbackURL).not.toContain('attacker');
  });

  it('uses the explicit signup intent for Google account creation', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockReturnValue(new Promise(() => undefined));
    renderPortal('/signup');

    fireEvent.click(screen.getByRole('button', { name: 'Continue with Google' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      provider: 'google',
      requestSignUp: true,
    });
  });

  it('offers a known mailbox without guessing a destination for custom email domains', () => {
    expect(emailProviderForAddress('new-user@yandex.ru')).toEqual({
      href: 'https://mail.yandex.ru/',
      label: 'Open Yandex Mail',
    });
    expect(emailProviderForAddress('owner@company.example')).toBeNull();
  });

  it('uses an eight-character password rule with a live requirement hint', () => {
    renderPortal('/signup');

    const password = screen.getByLabelText('Password');
    const submit = screen.getByRole('button', { name: 'Create account' });

    expect(password).toHaveAttribute('minlength', '8');
    expect(screen.queryByText('8 or more characters')).not.toBeInTheDocument();
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Mira' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'new-user@example.test' } });
    fireEvent.change(password, { target: { value: 'short' } });
    expect(screen.getByText('8 or more characters')).toHaveAttribute('data-valid', 'false');
    expect(submit).toBeDisabled();
    fireEvent.change(password, { target: { value: 'long-enough' } });
    expect(screen.getByText('8 or more characters')).toHaveAttribute('data-valid', 'true');
    expect(submit).toBeEnabled();
  });

  it('ends an existing session, creates an unverified account, and opens a dedicated inbox step', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ user: { emailVerified: false } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    renderPortal('/signup?sig=signed&ba_param=client_id&ba_param=ba_param&client_id=customer');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Mira' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'new-user@yandex.ru' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'correct horse battery' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    await screen.findByRole('heading', { name: 'Check your inbox' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/auth/sign-out');
    const [url, request] = fetchMock.mock.calls[1]!;
    expect(url).toBe('/api/auth/sign-up/email');
    expect(JSON.parse(String(request?.body))).toMatchObject({
      name: 'Mira',
      email: 'new-user@yandex.ru',
      password: 'correct horse battery',
      oauth_query: expect.stringContaining('sig=signed'),
    });
    expect(screen.getByText(/Already registered\?/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Yandex Mail' }))
      .toHaveAttribute('href', 'https://mail.yandex.ru/');
    expect(screen.getByRole('link', { name: 'Already verified? Sign in' }))
      .toHaveAttribute('href', '/login?verified=1');
    expect(screen.getByRole('link', { name: 'Reset password' }))
      .toHaveAttribute('href', '/forgot');
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain('correct horse battery');
  });

  it('reveals and hides the sign-in password without changing its value', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ user: null, session: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    renderPortal('/login');
    const password = await screen.findByLabelText('Password');
    fireEvent.change(password, { target: { value: 'correct horse battery' } });

    expect(password).toHaveAttribute('type', 'password');
    fireEvent.click(screen.getByRole('button', { name: 'Show password' }));

    expect(password).toHaveAttribute('type', 'text');
    expect(password).toHaveValue('correct horse battery');
    expect(screen.getByRole('button', { name: 'Hide password' }))
      .toHaveAttribute('aria-pressed', 'true');

    const toggle = screen.getByRole('button', { name: 'Hide password' });
    expect(toggle).not.toHaveClass('absolute', '-translate-y-1/2');
    expect(toggle.parentElement).toHaveClass('absolute', 'inset-y-0', 'right-1', 'flex', 'items-center');

    fireEvent.click(screen.getByRole('button', { name: 'Hide password' }));
    expect(password).toHaveAttribute('type', 'password');
    expect(password).toHaveValue('correct horse battery');
  });

  it('turns an invalid sign-in into a specific actionable error', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ user: null, session: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 'INVALID_EMAIL_OR_PASSWORD' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }));
    renderPortal('/login');
    fireEvent.change(await screen.findByLabelText('Email'), { target: { value: 'owner@example.test' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'incorrect password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Email or password is incorrect.');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not destroy the verified session when the login fallback opens', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ user: null, session: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    renderPortal('/login?verified=1');

    expect(await screen.findByRole('heading', { name: 'Welcome back' })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/auth/get-session',
      expect.objectContaining({ credentials: 'include' }),
    );
    expect(screen.getByText('Email verified. You can sign in now.')).toBeInTheDocument();
  });

  it('uses the same forgot-password result and opens a known mailbox', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ status: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    renderPortal('/forgot');
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'owner@gmail.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send reset link' }));
    await screen.findByRole('heading', { name: 'Check your inbox' });
    expect(screen.getByText('If the account exists, a reset link is on its way.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Gmail' }))
      .toHaveAttribute('href', 'https://mail.google.com/');
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/auth/request-password-reset',
      expect.objectContaining({
        body: JSON.stringify({
          email: 'owner@gmail.com',
          redirectTo: 'https://auth.poolstatis.xyz/reset?reset_email=owner%40gmail.com',
        }),
        credentials: 'include',
      }),
    );
  });

  it('keeps the forgot-password inbox step useful for custom mail domains', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ status: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    renderPortal('/forgot');
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'owner@company.example' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send reset link' }));
    await screen.findByRole('heading', { name: 'Check your inbox' });
    expect(screen.getByText('Open your email provider to find the reset message.')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Open .*Mail/ })).not.toBeInTheDocument();
  });

  it('signs in automatically after a successful password reset', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      .mockReturnValueOnce(new Promise(() => undefined));
    renderPortal('/reset?reset_email=owner%40gmail.com&token=one-time-reset-token');
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'correct horse battery' } });
    fireEvent.click(screen.getByRole('button', { name: 'Update password' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/auth/reset-password');
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/auth/sign-in/email');
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({
      email: 'owner@gmail.com',
      password: 'correct horse battery',
      rememberMe: true,
    });
  });

  it('falls back to a prefilled readable sign-in form if reset succeeds but auto-login fails', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'invalid' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ user: null, session: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    renderPortal('/reset?reset_email=owner%40gmail.com&token=one-time-reset-token');
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'correct horse battery' } });
    fireEvent.click(screen.getByRole('button', { name: 'Update password' }));

    expect(await screen.findByRole('heading', { name: 'Welcome back' })).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toHaveValue('owner@gmail.com');
    expect(screen.getByText('Password updated. Sign in with the new password.')).toHaveClass('text-foreground', 'bg-muted');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('rejects invalid reset links before sending a password', () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    renderPortal('/reset?error=INVALID_TOKEN');
    expect(screen.getByText('This reset link is invalid or expired.')).toBeInTheDocument();
    expect(screen.queryByLabelText('New password')).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['verified', 'Email verified'],
    ['email_change_confirmed', 'Email change confirmed'],
    ['email_changed', 'Email updated'],
    ['already_verified', 'Email already verified'],
    ['already_used', 'Verification link already used'],
    ['invalid_or_expired', 'Verification link expired or invalid'],
  ])('renders a branded %s verification result', (state, heading) => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    renderPortal(`/verify?state=${state}`);
    expect(screen.getByRole('heading', { name: heading })).toBeInTheDocument();
    const completed = state === 'verified' || state === 'email_changed';
    expect(screen.getByRole('link', {
      name: completed ? 'Continue to Poolstatis' : 'Continue and sign in',
    })).toHaveAttribute('href', completed ? 'https://app.poolstatis.xyz/' : verificationContinueUrl);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('exchanges a fragment-only token once and removes it from browser history', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ state: 'verified' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const replace = vi.spyOn(window.history, 'replaceState');
    renderPortal('/verify#token=opaque-one-time-token');
    expect(screen.getByRole('status')).toHaveTextContent('Verifying…');
    await screen.findByRole('heading', { name: 'Email verified' });
    expect(replace).toHaveBeenCalledWith({}, expect.any(String), '/verify');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/auth/poolstatis/verify-email',
      expect.objectContaining({
        body: JSON.stringify({ token: 'opaque-one-time-token' }),
        credentials: 'include',
      }),
    );
    expect(document.body.textContent).not.toContain('opaque-one-time-token');
  });

  it('does not exchange the fragment twice under React StrictMode', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ state: 'verified' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    render(
      <StrictMode>
        <MemoryRouter initialEntries={['/verify#token=opaque-one-time-token']}>
          <AuthPortal />
        </MemoryRouter>
      </StrictMode>,
    );
    await screen.findByRole('heading', { name: 'Email verified' });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('retries a bounded busy verification exchange without exposing the token', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('{}', {
        status: 429,
        headers: { 'retry-after': '0' },
      }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ state: 'verified' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    renderPortal('/verify#token=opaque-one-time-token');
    await screen.findByRole('heading', { name: 'Email verified' }, {
      timeout: 1_500,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).not.toContain('opaque-one-time-token');
  });

  it('keeps a busy link retryable without misclassifying or resending it', async () => {
    const busy = () => new Response('{}', {
      status: 429,
      headers: { 'retry-after': '0' },
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(busy())
      .mockResolvedValueOnce(busy())
      .mockResolvedValueOnce(busy())
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ state: 'verified' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    renderPortal('/verify#token=opaque-one-time-token');
    await screen.findByRole('heading', {
      name: 'Verification is temporarily unavailable',
    });
    expect(screen.queryByText(/expired or invalid/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', {
      name: 'Send a new verification email',
    })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', {
      name: 'Try verification again',
    }));
    await screen.findByRole('heading', { name: 'Email verified' });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(document.body.textContent).not.toContain('opaque-one-time-token');
  });

  it('keeps resend neutral, clears the address, and exposes a polite live result', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ status: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    renderPortal('/verify?state=invalid_or_expired');
    const email = screen.getByLabelText('Email');
    fireEvent.change(email, { target: { value: 'unknown@example.test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send a new verification email' }));
    const result = await screen.findByRole('status');
    expect(result).toHaveTextContent(
      'If an unverified account exists, a new verification email is on its way.',
    );
    expect(result).toHaveClass('text-foreground', 'bg-primary/10');
    await waitFor(() => expect(result).toHaveFocus());
    expect(email).toHaveValue('');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/auth/send-verification-email',
      expect.objectContaining({
        body: JSON.stringify({
          email: 'unknown@example.test',
          callbackURL: 'https://auth.poolstatis.xyz/verify',
        }),
      }),
    );
  });

  it('restores focus to the resend result after a delayed verification-heading focus', async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ status: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    renderPortal('/verify?state=invalid_or_expired');
    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'unknown@example.test' },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send a new verification email' }));
      await Promise.resolve();
      await Promise.resolve();
    });

    const result = screen.getByRole('status');
    screen.getByRole('heading', { name: 'Verification link expired or invalid' }).focus();
    expect(result).not.toHaveFocus();

    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });
    expect(result).toHaveFocus();
  });

  it('distinguishes a throttled resend without exposing account existence', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'rate_limited' } }), {
        status: 429,
        headers: { 'content-type': 'application/json' },
      }),
    );
    renderPortal('/verify?state=invalid_or_expired');
    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'unknown@example.test' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send a new verification email' }));
    const result = await screen.findByRole('status');
    expect(result).toHaveTextContent('Please wait before requesting another verification email.');
    expect(result).toHaveClass('text-muted-foreground');
    expect(result).not.toHaveClass('text-success');
    await waitFor(() => expect(result).toHaveFocus());
    expect(document.body.textContent).not.toContain('unknown@example.test');
  });

  it('disables duplicate signup submissions while the request is pending', async () => {
    let resolve: ((response: Response) => void) | undefined;
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true }), { status: 200 }))
      .mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    renderPortal('/signup');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Mira' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'mira@example.test' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'correct horse battery' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    const pending = await screen.findByRole('button', { name: 'Creating…' });
    expect(pending).toBeDisabled();
    fireEvent.click(pending);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    resolve?.(new Response(JSON.stringify({ user: {} }), { status: 200 }));
    expect(await screen.findByRole('heading', { name: 'Check your inbox' })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns from account management to the app without an AI gradient strip', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ user: { name: 'Mira', email: 'mira@example.test' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const view = renderPortal('/profile');
    expect(await screen.findByText('Your account')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to Poolstatis' }))
      .toHaveAttribute('href', 'https://app.poolstatis.xyz/profile');
    expect(view.container.querySelector('main .bg-gradient-to-r')).toBeNull();
  });
});
