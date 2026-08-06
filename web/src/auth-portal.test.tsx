import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  approvedOAuthRedirect,
  AuthPortal,
  authenticatedAppRedirect,
  emailProviderForAddress,
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
    vi.useRealTimers();
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
    expect(screen.getByText('Poolstatis Cloud · beta')).toHaveClass('text-success');
    expect(screen.getByRole('heading', { name: 'Create your account' })).toBeInTheDocument();
  });

  it('offers a known mailbox without guessing a destination for custom email domains', () => {
    expect(emailProviderForAddress('new-user@yandex.ru')).toEqual({
      href: 'https://mail.yandex.ru/',
      label: 'Open Yandex Mail',
    });
    expect(emailProviderForAddress('owner@company.example')).toBeNull();
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
    expect(screen.getByRole('link', { name: 'Open Yandex Mail' }))
      .toHaveAttribute('href', 'https://mail.yandex.ru/');
    expect(screen.getByRole('link', { name: 'Already verified? Sign in' }))
      .toHaveAttribute('href', '/login?verified=1&reauth=1');
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

  it('clears a saved identity before showing the post-verification sign-in form', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    renderPortal(
      '/login?verified=1&reauth=1&sig=signed'
      + '&ba_param=client_id&ba_param=ba_param&client_id=customer',
    );

    expect(await screen.findByRole('heading', { name: 'Welcome back' })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/auth/sign-out',
      expect.objectContaining({ credentials: 'include', method: 'POST' }),
    );
    expect(screen.getByText('Email verified. You can sign in now.')).toBeInTheDocument();
  });

  it('uses the same forgot-password result for every account', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ status: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    renderPortal('/forgot');
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'unknown@example.test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send reset link' }));
    await screen.findByText('If the account exists, a reset link is on its way.');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/auth/request-password-reset',
      expect.objectContaining({ credentials: 'include' }),
    );
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
    expect(screen.getByRole('link', { name: 'Continue and sign in' }))
      .toHaveAttribute('href', verificationContinueUrl);
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
    expect(result).toHaveFocus();
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
