import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
});
