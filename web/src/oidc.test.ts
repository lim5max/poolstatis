import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { createElement, StrictMode } from 'react';
import { BrowserRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  completeHostedSigninCallback,
  createHostedUserManager,
  clearHostedSessionMarkers,
  HostedAuthProvider,
  hostedAccessToken,
  hostedAuthScope,
  hostedReturnTo,
  hostedSessionMarkerKey,
  markHostedSessionConnected,
  replaceHostedRoute,
  restoreHostedSession,
  signoutHostedUser,
  useHostedAuth,
} from './oidc';
import type { User, UserManager } from 'oidc-client-ts';

describe('customer OIDC client policy', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    window.history.replaceState({}, '', '/');
  });

  afterEach(() => cleanup());

  it('uses authorization code PKCE, an explicit API resource, and no persistent token store', async () => {
    const manager = createHostedUserManager(window, {
      authority: 'https://auth.poolstatis.xyz',
      clientId: 'poolstatis-customer-web',
      audience: 'https://api.poolstatis.xyz',
      apiUrl: 'https://api.poolstatis.xyz',
    });
    expect(manager.settings.response_type).toBe('code');
    expect(manager.settings.scope).toBe(hostedAuthScope);
    expect(manager.settings.resource).toBe('https://api.poolstatis.xyz');
    expect(manager.settings.post_logout_redirect_uri).toBe('https://auth.poolstatis.xyz/login');
    expect(manager.settings.extraTokenParams).toEqual({
      resource: 'https://api.poolstatis.xyz',
    });
    expect(manager.settings.automaticSilentRenew).toBe(false);
    expect(manager.settings.loadUserInfo).toBe(false);
    await manager.settings.userStore.set('access', 'secret-token');
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(await manager.settings.userStore.get('access')).toBe('secret-token');
    await manager.settings.stateStore.set('flow', 'pkce-state');
    expect(sessionStorage.length).toBe(1);
    expect(localStorage.length).toBe(0);
  });

  it('clears the auth cookie without exposing an id token in browser navigation', async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true });
    const assign = vi.fn();

    await signoutHostedUser(
      { location: { assign } },
      fetcher as unknown as typeof fetch,
    );

    expect(fetcher).toHaveBeenCalledWith(
      'https://auth.poolstatis.xyz/api/auth/sign-out',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
      }),
    );
    expect(assign).toHaveBeenCalledWith('https://auth.poolstatis.xyz/login');
  });

  it('does not redirect when the auth cookie could not be cleared', async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: false });
    const assign = vi.fn();

    await expect(signoutHostedUser(
      { location: { assign } },
      fetcher as unknown as typeof fetch,
    )).rejects.toThrow('Hosted sign-out could not be completed');

    expect(assign).not.toHaveBeenCalled();
  });

  it('uses the callback user immediately without re-reading the in-memory user store', async () => {
    const callbackUser = {
      access_token: 'callback-access-token',
      expired: false,
    } as User;
    const manager = {
      getUser: async () => {
        throw new Error('the callback user is not visible through the store yet');
      },
      signinSilent: async () => {
        throw new Error('silent renewal is not needed');
      },
    };

    await expect(hostedAccessToken(
      manager,
      callbackUser,
      'https://api.poolstatis.xyz',
    )).resolves.toBe('callback-access-token');
  });

  it('restores a connected browser through a fresh PKCE redirect without persisting tokens', async () => {
    const persistent = new Map<string, string>();
    const flow = new Map<string, string>();
    const signinRedirect = vi.fn().mockResolvedValue(undefined);
    const persistentStorage = {
      getItem: (key: string) => persistent.get(key) ?? null,
      setItem: (key: string, value: string) => persistent.set(key, value),
      removeItem: (key: string) => persistent.delete(key),
    };
    const flowStorage = {
      getItem: (key: string) => flow.get(key) ?? null,
      setItem: (key: string, value: string) => flow.set(key, value),
      removeItem: (key: string) => flow.delete(key),
    };

    markHostedSessionConnected(persistentStorage);
    await expect(restoreHostedSession(
      { signinRedirect },
      persistentStorage,
      flowStorage,
      'https://api.poolstatis.xyz',
      '/usage',
    )).resolves.toBe(true);
    await expect(restoreHostedSession(
      { signinRedirect },
      persistentStorage,
      flowStorage,
      'https://api.poolstatis.xyz',
      '/usage',
    )).resolves.toBe(false);

    expect(signinRedirect).toHaveBeenCalledOnce();
    expect(signinRedirect).toHaveBeenCalledWith({
      resource: 'https://api.poolstatis.xyz',
      state: { returnTo: '/usage' },
    });
    expect(persistent.get(hostedSessionMarkerKey)).toBe('connected');
    expect([...persistent.values()]).toEqual(['connected']);

    clearHostedSessionMarkers(persistentStorage, flowStorage);
    expect(persistent.size).toBe(0);
    expect(flow.size).toBe(0);
  });

  it('fails a restore without leaving the StrictMode redirect guard stuck', async () => {
    const persistent = new Map([[hostedSessionMarkerKey, 'connected']]);
    const flow = new Map<string, string>();
    const persistentStorage = {
      getItem: (key: string) => persistent.get(key) ?? null,
    };
    const flowStorage = {
      getItem: (key: string) => flow.get(key) ?? null,
      setItem: (key: string, value: string) => flow.set(key, value),
      removeItem: (key: string) => flow.delete(key),
    };
    const signinRedirect = vi.fn().mockRejectedValue(new Error('redirect failed'));

    await expect(restoreHostedSession(
      { signinRedirect },
      persistentStorage,
      flowStorage,
      'https://api.poolstatis.xyz',
      '/',
    )).rejects.toThrow('redirect failed');
    expect(flow.size).toBe(0);
  });

  it('keeps auth unresolved after an SSO restore redirect starts under StrictMode', async () => {
    localStorage.setItem(hostedSessionMarkerKey, 'connected');
    const manager = {
      events: {
        addUserLoaded: vi.fn(),
        addUserUnloaded: vi.fn(),
        removeUserLoaded: vi.fn(),
        removeUserUnloaded: vi.fn(),
      },
      getUser: vi.fn().mockResolvedValue(null),
      signinRedirect: vi.fn().mockResolvedValue(undefined),
      signinRedirectCallback: vi.fn(),
      signoutRedirect: vi.fn(),
      signinSilent: vi.fn(),
    } as unknown as UserManager;

    function LoadingProbe() {
      const auth = useHostedAuth();
      return createElement(
        'output',
        null,
        auth.isLoading ? 'auth unresolved' : 'auth resolved unauthenticated',
      );
    }

    render(createElement(
      StrictMode,
      null,
      createElement(HostedAuthProvider, {
        manager,
        children: createElement(LoadingProbe),
      }),
    ));

    await waitFor(() => expect(manager.signinRedirect).toHaveBeenCalledOnce());
    expect(screen.getByText('auth unresolved')).toBeInTheDocument();
    expect(screen.queryByText('auth resolved unauthenticated')).not.toBeInTheDocument();
  });

  it('consumes a callback once under StrictMode and restores its safe route', async () => {
    window.history.replaceState({}, '', '/?code=callback&state=flow');
    const callbackUser = {
      access_token: 'callback-access-token',
      expired: false,
      state: { returnTo: '/usage' },
      profile: {},
    } as User;
    let resolveCallback!: (user: User) => void;
    const callbackPromise = new Promise<User>((resolve) => {
      resolveCallback = resolve;
    });
    const signinRedirectCallback = vi.fn().mockReturnValue(callbackPromise);
    const manager = {
      events: {
        addUserLoaded: vi.fn(),
        addUserUnloaded: vi.fn(),
        removeUserLoaded: vi.fn(),
        removeUserUnloaded: vi.fn(),
      },
      getUser: vi.fn(),
      signinRedirect: vi.fn(),
      signinRedirectCallback,
      signoutRedirect: vi.fn(),
      signinSilent: vi.fn(),
    } as unknown as UserManager;

    function Probe() {
      const auth = useHostedAuth();
      const location = useLocation();
      return createElement(
        'output',
        null,
        `${location.pathname}:${auth.isAuthenticated ? 'authenticated' : 'anonymous'}`,
      );
    }

    render(createElement(
      StrictMode,
      null,
      createElement(HostedAuthProvider, {
        manager,
        children: createElement(BrowserRouter, null, createElement(Probe)),
      }),
    ));
    resolveCallback(callbackUser);

    await screen.findByText('/usage:authenticated');
    expect(signinRedirectCallback).toHaveBeenCalledOnce();
    expect(window.location.pathname).toBe('/usage');
    expect(window.location.search).toBe('');
  });

  it('handles an OIDC error callback once and allows a clean retry', async () => {
    localStorage.setItem(hostedSessionMarkerKey, 'connected');
    sessionStorage.setItem('poolstatis.customer.restore', 'started');
    window.history.replaceState({}, '', '/?error=access_denied&state=flow');
    const signinRedirectCallback = vi.fn().mockRejectedValue(new Error('provider detail'));
    const manager = {
      events: {
        addUserLoaded: vi.fn(),
        addUserUnloaded: vi.fn(),
        removeUserLoaded: vi.fn(),
        removeUserUnloaded: vi.fn(),
      },
      getUser: vi.fn(),
      signinRedirect: vi.fn(),
      signinRedirectCallback,
      signoutRedirect: vi.fn(),
      signinSilent: vi.fn(),
    } as unknown as UserManager;

    function ErrorProbe() {
      const auth = useHostedAuth();
      return createElement('output', null, auth.error?.message ?? 'no error');
    }

    render(createElement(
      StrictMode,
      null,
      createElement(HostedAuthProvider, {
        manager,
        children: createElement(ErrorProbe),
      }),
    ));

    await screen.findByText('Sign-in could not be completed. Try again.');
    await waitFor(() => expect(window.location.pathname).toBe('/login'));
    expect(signinRedirectCallback).toHaveBeenCalledOnce();
    expect(localStorage.getItem(hostedSessionMarkerKey)).toBeNull();
    expect(sessionStorage.getItem('poolstatis.customer.restore')).toBeNull();
  });

  it('accepts only local absolute return paths', () => {
    expect(hostedReturnTo({ returnTo: '/usage' })).toBe('/usage');
    expect(hostedReturnTo({ returnTo: 'https://attacker.example/' })).toBe('/');
    expect(hostedReturnTo({ returnTo: '//attacker.example/' })).toBe('/');
    expect(hostedReturnTo(null)).toBe('/');
  });

  it('notifies BrowserRouter when replacing an OAuth callback URL', async () => {
    function RouteProbe() {
      return createElement('output', null, useLocation().pathname);
    }
    render(createElement(BrowserRouter, null, createElement(RouteProbe)));

    act(() => replaceHostedRoute(window, '/onboarding'));

    await screen.findByText('/onboarding');
  });

  it('shares a callback promise for the same manager', async () => {
    const callbackUser = { access_token: 'token' } as User;
    const signinRedirectCallback = vi.fn().mockResolvedValue(callbackUser);
    const manager = { signinRedirectCallback };
    await expect(Promise.all([
      completeHostedSigninCallback(manager),
      completeHostedSigninCallback(manager),
    ])).resolves.toEqual([callbackUser, callbackUser]);
    expect(signinRedirectCallback).toHaveBeenCalledOnce();
  });
});
