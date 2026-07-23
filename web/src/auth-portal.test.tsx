import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  approvedOAuthRedirect,
  AuthPortal,
  signedOAuthQuery,
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

  it('creates an unverified account and keeps the password inside the auth request', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ user: { emailVerified: false } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    renderPortal('/signup?sig=signed&ba_param=client_id&ba_param=ba_param&client_id=customer');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Mira' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'mira@example.test' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'correct horse battery' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    await screen.findByText('Check your email to verify the account, then sign in.');
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, request] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/auth/sign-up/email');
    expect(JSON.parse(String(request?.body))).toMatchObject({
      name: 'Mira',
      email: 'mira@example.test',
      password: 'correct horse battery',
      oauth_query: expect.stringContaining('sig=signed'),
    });
    expect(screen.getByLabelText('Password')).toHaveValue('');
    expect(document.body.textContent).not.toContain('correct horse battery');
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

  it('disables duplicate signup submissions while the request is pending', async () => {
    let resolve: ((response: Response) => void) | undefined;
    vi.spyOn(globalThis, 'fetch').mockReturnValue(new Promise((done) => { resolve = done; }));
    renderPortal('/signup');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Mira' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'mira@example.test' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'correct horse battery' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(screen.getByRole('button', { name: 'Creating…' })).toBeDisabled();
    resolve?.(new Response(JSON.stringify({ user: {} }), { status: 200 }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create account' })).toBeEnabled());
  });
});
