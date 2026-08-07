import { UserManager, WebStorageStateStore, type User } from 'oidc-client-ts';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { AccessTokenProvider, AccessTokenRequest } from './api/client';

export const hostedAuthConfig = {
  authority: (import.meta.env.VITE_OIDC_AUTHORITY as string | undefined)?.replace(/\/$/, ''),
  clientId: import.meta.env.VITE_OIDC_CLIENT_ID as string | undefined,
  audience: (import.meta.env.VITE_OIDC_AUDIENCE as string | undefined)?.replace(/\/$/, ''),
  apiUrl: ((import.meta.env.VITE_POOLSTATIS_API_URL as string | undefined) ?? '').replace(/\/$/, ''),
};

export const hostedAuthScope = 'openid profile email offline_access poolstatis:customer';
export const hostedSessionMarkerKey = 'poolstatis.customer.sso';
export const hostedLogoutUrl = 'https://auth.poolstatis.xyz/login';
const hostedRestoreMarkerKey = 'poolstatis.customer.restore';
const callbackPromises = new WeakMap<UserManager, Promise<User>>();
const refreshPromises = new WeakMap<object, Promise<User | null>>();
export const hostedAuthEnabled = Boolean(
  hostedAuthConfig.authority === 'https://auth.poolstatis.xyz'
  && hostedAuthConfig.clientId
  && hostedAuthConfig.audience === 'https://api.poolstatis.xyz'
  && hostedAuthConfig.apiUrl,
);
export const hostedAuthIncomplete = Boolean(
  hostedAuthConfig.authority
  || hostedAuthConfig.clientId
  || hostedAuthConfig.audience
  || hostedAuthConfig.apiUrl,
) && !hostedAuthEnabled;

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

export function createHostedUserManager(
  browserWindow: Window = window,
  config: typeof hostedAuthConfig = hostedAuthConfig,
) {
  const callback = new URL('/', browserWindow.location.origin).toString();
  return new UserManager({
    authority: config.authority!,
    client_id: config.clientId!,
    redirect_uri: callback,
    post_logout_redirect_uri: hostedLogoutUrl,
    response_type: 'code',
    scope: hostedAuthScope,
    resource: config.audience!,
    extraTokenParams: {
      resource: config.audience!,
    },
    automaticSilentRenew: false,
    monitorSession: false,
    loadUserInfo: false,
    userStore: new WebStorageStateStore({
      store: new MemoryStorage(),
      prefix: 'poolstatis.customer.user.',
    }),
    stateStore: new WebStorageStateStore({
      store: browserWindow.sessionStorage,
      prefix: 'poolstatis.customer.flow.',
    }),
  });
}

export async function signoutHostedUser(
  browserWindow: { location: Pick<Location, 'assign'> } = window,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const authority = hostedAuthConfig.authority ?? 'https://auth.poolstatis.xyz';
  const response = await fetcher(`${authority}/api/auth/sign-out`, {
    method: 'POST',
    credentials: 'include',
    headers: { accept: 'application/json' },
  });
  if (!response.ok) throw new Error('Hosted sign-out could not be completed');
  browserWindow.location.assign(hostedLogoutUrl);
}

export function markHostedSessionConnected(storage: Pick<Storage, 'setItem'> = localStorage): void {
  storage.setItem(hostedSessionMarkerKey, 'connected');
}

export function clearHostedSessionMarkers(
  persistentStorage: Pick<Storage, 'removeItem'> = localStorage,
  flowStorage: Pick<Storage, 'removeItem'> = sessionStorage,
): void {
  persistentStorage.removeItem(hostedSessionMarkerKey);
  flowStorage.removeItem(hostedRestoreMarkerKey);
}

export async function restoreHostedSession(
  manager: Pick<UserManager, 'signinRedirect'>,
  persistentStorage: Pick<Storage, 'getItem'>,
  flowStorage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
  audience: string,
  returnTo: string,
): Promise<boolean> {
  if (
    persistentStorage.getItem(hostedSessionMarkerKey) !== 'connected'
    || flowStorage.getItem(hostedRestoreMarkerKey) === 'started'
  ) return false;

  flowStorage.setItem(hostedRestoreMarkerKey, 'started');
  try {
    await manager.signinRedirect({
      resource: audience,
      state: { returnTo },
    });
    return true;
  } catch (error) {
    flowStorage.removeItem(hostedRestoreMarkerKey);
    throw error;
  }
}

export function completeHostedSigninCallback(
  manager: Pick<UserManager, 'signinRedirectCallback'>,
): Promise<User> {
  const keyedManager = manager as UserManager;
  const existing = callbackPromises.get(keyedManager);
  if (existing) return existing;
  const callback = manager.signinRedirectCallback();
  callbackPromises.set(keyedManager, callback);
  return callback;
}

export function hostedReturnTo(state: unknown): string {
  if (!state || typeof state !== 'object') return '/';
  const returnTo = (state as { returnTo?: unknown }).returnTo;
  if (
    typeof returnTo !== 'string'
    || !returnTo.startsWith('/')
    || returnTo.startsWith('//')
  ) return '/';
  return returnTo;
}

export function replaceHostedRoute(browserWindow: Window, path: string): void {
  browserWindow.history.replaceState({}, browserWindow.document.title, path);
  browserWindow.dispatchEvent(new PopStateEvent('popstate'));
}

export async function hostedAccessToken(
  manager: Pick<UserManager, 'getUser' | 'signinSilent'>,
  callbackUser: User | null,
  audience: string,
  request: AccessTokenRequest = {},
): Promise<string> {
  let current: User | null;
  if (request.forceRefresh) {
    try {
      current = await manager.getUser();
    } catch {
      throw new Error('Your session expired. Sign in again.');
    }
    if (!current?.refresh_token) throw new Error('Your session expired. Sign in again.');
  } else {
    current = callbackUser && !callbackUser.expired
      ? callbackUser
      : await manager.getUser();
  }
  if ((request.forceRefresh || current?.expired) && current?.refresh_token) {
    try {
      const keyedManager = manager as object;
      let refresh = refreshPromises.get(keyedManager);
      if (!refresh) {
        refresh = manager.signinSilent({ resource: audience });
        refreshPromises.set(keyedManager, refresh);
      }
      try {
        current = await refresh;
      } finally {
        if (refreshPromises.get(keyedManager) === refresh) refreshPromises.delete(keyedManager);
      }
    } catch {
      throw new Error('Your session expired. Sign in again.');
    }
  }
  if (!current || current.expired) throw new Error('OIDC session is unavailable');
  return current.access_token;
}

type HostedAuthState = {
  isAuthenticated: boolean;
  isLoading: boolean;
  user: User['profile'] | null;
  error: Error | null;
  login(): Promise<void>;
  logout(): Promise<void>;
  getToken: AccessTokenProvider;
};

const disabledState: HostedAuthState = {
  isAuthenticated: false,
  isLoading: false,
  user: null,
  error: null,
  async login() { throw new Error('hosted authentication is unavailable'); },
  async logout() {},
  async getToken() { throw new Error('hosted authentication is unavailable'); },
};
const HostedAuthContext = createContext<HostedAuthState>(disabledState);

export function HostedAuthProvider({
  children,
  manager: providedManager,
}: {
  children: ReactNode;
  manager?: UserManager;
}) {
  const manager = useMemo(
    () => providedManager ?? createHostedUserManager(),
    [providedManager],
  );
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let live = true;
    const loaded = (next: User) => { if (live) setUser(next); };
    const unloaded = () => { if (live) setUser(null); };
    manager.events.addUserLoaded(loaded);
    manager.events.addUserUnloaded(unloaded);
    void (async () => {
      const query = new URLSearchParams(window.location.search);
      const isCallback = query.has('state')
        && (query.has('code') || query.has('error'));
      let redirecting = false;
      try {
        if (isCallback) {
          try {
            const callbackUser = await completeHostedSigninCallback(manager);
            if (!live) return;
            setUser(callbackUser);
            replaceHostedRoute(window, hostedReturnTo(callbackUser.state));
          } finally {
            window.sessionStorage.removeItem(hostedRestoreMarkerKey);
          }
        } else {
          const current = await manager.getUser();
          if (!live) return;
          setUser(current);
          if (!current) {
            redirecting = await restoreHostedSession(
              manager,
              window.localStorage,
              window.sessionStorage,
              hostedAuthConfig.audience!,
              window.location.pathname,
            );
          }
        }
      } catch (cause) {
        if (!live) return;
        if (isCallback) {
          clearHostedSessionMarkers(window.localStorage, window.sessionStorage);
          replaceHostedRoute(window, '/login');
          setError(new Error('Sign-in could not be completed. Try again.'));
        } else {
          setError(cause as Error);
        }
      } finally {
        if (live && !redirecting) setLoading(false);
      }
    })();
    return () => {
      live = false;
      manager.events.removeUserLoaded(loaded);
      manager.events.removeUserUnloaded(unloaded);
    };
  }, [manager]);

  const login = useCallback(async () => {
    await manager.signinRedirect({
      resource: hostedAuthConfig.audience!,
      state: { returnTo: window.location.pathname },
    });
  }, [manager]);
  const logout = useCallback(async () => {
    clearHostedSessionMarkers(window.localStorage, window.sessionStorage);
    await signoutHostedUser();
  }, []);
  const getToken = useCallback(async (request?: AccessTokenRequest) => {
    return hostedAccessToken(manager, user, hostedAuthConfig.audience!, request);
  }, [manager, user]);

  return (
    <HostedAuthContext.Provider value={{
      isAuthenticated: Boolean(user && !user.expired),
      isLoading: loading,
      user: user?.profile ?? null,
      error,
      login,
      logout,
      getToken,
    }}>
      {children}
    </HostedAuthContext.Provider>
  );
}

export function OptionalHostedAuthProvider({ children }: { children: ReactNode }) {
  if (
    !hostedAuthEnabled
    || window.location.hostname === 'auth.poolstatis.xyz'
  ) return <>{children}</>;
  return <HostedAuthProvider>{children}</HostedAuthProvider>;
}

export function useHostedAuth() {
  return useContext(HostedAuthContext);
}

export function useHostedToken() {
  const { getToken } = useHostedAuth();
  return useCallback((request?: AccessTokenRequest) => getToken(request), [getToken]);
}
