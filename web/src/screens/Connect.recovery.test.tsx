import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';

const auth = vi.hoisted(() => ({
  isAuthenticated: true,
  isLoading: false,
  login: vi.fn(),
  logout: vi.fn(),
  user: { email: 'owner@example.test' },
  error: null,
  getToken: vi.fn().mockResolvedValue('access-token'),
}));
const store = vi.hoisted(() => ({
  connectHosted: vi.fn(),
}));

vi.mock('../oidc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../oidc')>()),
  hostedAuthConfig: {
    authority: 'https://auth.poolstatis.xyz',
    clientId: 'poolstatis-customer-web',
    audience: 'https://api.poolstatis.xyz',
    apiUrl: 'https://api.poolstatis.xyz',
  },
  useHostedAuth: () => auth,
  useHostedToken: () => auth.getToken,
}));
vi.mock('../store', () => ({
  useStore: () => store,
}));

import { HostedConnect } from './Connect';

describe('hosted connection recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.isAuthenticated = true;
    auth.isLoading = false;
    auth.error = null;
  });

  it('signs out a stale SSO identity before allowing another login', async () => {
    store.connectHosted.mockRejectedValueOnce(
      new ApiError('authentication_failed', 'authentication failed', undefined, 401),
    );
    render(<HostedConnect />);

    const recovery = await screen.findByRole('button', { name: 'Sign out and try again' });
    expect(screen.getByText(
      'Your sign-in session is unavailable or expired. Verify your email, then sign in again.',
    )).toBeInTheDocument();
    fireEvent.click(recovery);

    await waitFor(() => expect(auth.logout).toHaveBeenCalledOnce());
    expect(auth.login).not.toHaveBeenCalled();
    expect(store.connectHosted).toHaveBeenCalledOnce();
  });

  it('keeps auth actions hidden while initial auth state is unresolved', () => {
    auth.isAuthenticated = false;
    auth.isLoading = true;

    render(<HostedConnect />);

    expect(screen.getByTestId('auth-boot-shell')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByText('Restoring your workspace…')).not.toBeInTheDocument();
    expect(screen.queryByText('Sign in to your workspace.')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Continue to sign in' })).not.toBeInTheDocument();
    expect(store.connectHosted).not.toHaveBeenCalled();
  });

  it('transitions atomically from unknown auth to authenticated workspace bootstrap', async () => {
    auth.isAuthenticated = false;
    auth.isLoading = true;
    store.connectHosted.mockImplementation(() => new Promise(() => {}));
    const view = render(<HostedConnect />);

    auth.isAuthenticated = true;
    auth.isLoading = false;
    view.rerender(<HostedConnect />);

    expect(screen.getByTestId('auth-boot-shell')).toBeInTheDocument();
    expect(screen.queryByText('Sign in to your workspace.')).not.toBeInTheDocument();
    await waitFor(() => expect(store.connectHosted).toHaveBeenCalledOnce());
  });

  it('starts sign in automatically after auth resolves unauthenticated', async () => {
    auth.isAuthenticated = false;
    auth.isLoading = true;
    auth.login.mockResolvedValue(undefined);
    const view = render(<HostedConnect />);

    auth.isLoading = false;
    view.rerender(<HostedConnect />);

    expect(screen.getByTestId('auth-boot-shell')).toBeInTheDocument();
    expect(screen.queryByText('Sign in to your workspace.')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Continue to sign in' })).not.toBeInTheDocument();
    await waitFor(() => expect(auth.login).toHaveBeenCalledOnce());
  });

  it('starts one automatic sign in under StrictMode', async () => {
    auth.isAuthenticated = false;
    auth.login.mockResolvedValue(undefined);

    render(<StrictMode><HostedConnect /></StrictMode>);

    await waitFor(() => expect(auth.login).toHaveBeenCalledOnce());
    expect(screen.getByTestId('auth-boot-shell')).toBeInTheDocument();
  });

  it('keeps a deep-link restore neutral while the hosted workspace request is pending', async () => {
    window.history.replaceState({}, '', '/experience');
    store.connectHosted.mockImplementation(() => new Promise(() => {}));

    render(<HostedConnect />);

    expect(screen.getByTestId('auth-boot-shell')).toBeInTheDocument();
    expect(screen.queryByText('Sign in to your workspace.')).not.toBeInTheDocument();
    await waitFor(() => expect(store.connectHosted).toHaveBeenCalledOnce());
    expect(window.location.pathname).toBe('/experience');
  });

  it('shows a recovery state instead of auth copy after a network timeout', async () => {
    store.connectHosted.mockRejectedValueOnce(new Error('request timed out'));

    render(<HostedConnect />);

    await screen.findByText('Workspace could not be restored.');
    expect(screen.getByText('request timed out')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled();
    expect(screen.queryByText('Sign in to your workspace.')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Continue to sign in' })).not.toBeInTheDocument();
  });

  it('runs one workspace bootstrap under StrictMode', async () => {
    store.connectHosted.mockImplementation(() => new Promise(() => {}));

    render(<StrictMode><HostedConnect /></StrictMode>);

    await waitFor(() => expect(store.connectHosted).toHaveBeenCalledOnce());
    expect(screen.getByTestId('auth-boot-shell')).toBeInTheDocument();
    expect(screen.queryByText('Sign in to your workspace.')).not.toBeInTheDocument();
  });
});
