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

export const hostedAuthConfig = {
  authority: (import.meta.env.VITE_OIDC_AUTHORITY as string | undefined)?.replace(/\/$/, ''),
  clientId: import.meta.env.VITE_OIDC_CLIENT_ID as string | undefined,
  audience: (import.meta.env.VITE_OIDC_AUDIENCE as string | undefined)?.replace(/\/$/, ''),
  apiUrl: ((import.meta.env.VITE_POOLSTATIS_API_URL as string | undefined) ?? '').replace(/\/$/, ''),
};

export const hostedAuthScope = 'openid profile email offline_access poolstatis:customer';
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
    post_logout_redirect_uri: callback,
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
  manager: Pick<UserManager, 'signoutRedirect'>,
): Promise<void> {
  await manager.signoutRedirect();
}

export async function hostedAccessToken(
  manager: Pick<UserManager, 'getUser' | 'signinSilent'>,
  callbackUser: User | null,
  audience: string,
): Promise<string> {
  let current = callbackUser ?? await manager.getUser();
  if (current?.expired && current.refresh_token) {
    current = await manager.signinSilent({ resource: audience });
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
  getToken(): Promise<string>;
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

function HostedAuthProvider({ children }: { children: ReactNode }) {
  const manager = useMemo(() => createHostedUserManager(), []);
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
      try {
        const query = new URLSearchParams(window.location.search);
        if (query.has('code') && query.has('state')) {
          const callbackUser = await manager.signinRedirectCallback();
          if (live) setUser(callbackUser);
          window.history.replaceState({}, document.title, '/');
        } else if (live) {
          setUser(await manager.getUser());
        }
      } catch (cause) {
        if (live) setError(cause as Error);
      } finally {
        if (live) setLoading(false);
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
    await signoutHostedUser(manager);
  }, [manager]);
  const getToken = useCallback(async () => {
    return hostedAccessToken(manager, user, hostedAuthConfig.audience!);
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
  return useCallback(() => getToken(), [getToken]);
}
