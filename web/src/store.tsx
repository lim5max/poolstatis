import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { PoolstatisClient } from './api/client';
import type { AccountMe, KeyKind, ProjectWithStats } from './api/types';

const LS_KEY = 'poolstatis.conn';

interface Conn {
  baseUrl: string;
  token: string;
}

interface HostedConn {
  baseUrl: string;
  getToken: () => Promise<string>;
}

interface Store {
  client: PoolstatisClient | null;
  baseUrl: string;
  token: string;
  tokenKind: KeyKind | null;
  projectScope: 'org' | 'project' | null;
  account: AccountMe | null;
  projects: ProjectWithStats[];
  project: string | null;
  env: string;
  availableEnvs: string[];
  setEnv: (e: string) => void;
  setProject: (slug: string) => void;
  refreshProjects: () => Promise<void>;
  refreshAccount: () => Promise<void>;
  connect: (c: Conn) => Promise<void>;
  connectHosted: (c: HostedConn) => Promise<void>;
  disconnect: () => void;
}

const ENV_KEY = 'poolstatis.env';

function kindOf(token: string): KeyKind | null {
  if (token.startsWith('pk_')) return 'ingest';
  if (token.startsWith('sk_')) return 'secret';
  if (token.startsWith('pt_')) return 'personal';
  return null;
}

const Ctx = createContext<Store | null>(null);

function loadConn(): Conn | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? (JSON.parse(raw) as Conn) : null;
  } catch {
    return null;
  }
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const saved = loadConn();
  const [baseUrl, setBaseUrl] = useState(saved?.baseUrl ?? '');
  const [token, setToken] = useState(saved?.token ?? '');
  const [hostedToken, setHostedToken] = useState<(() => Promise<string>) | null>(null);
  const [explicitKind, setExplicitKind] = useState<KeyKind | null>(saved ? kindOf(saved.token) : null);
  const [projectScope, setProjectScope] = useState<'org' | 'project' | null>(null);
  const [account, setAccount] = useState<AccountMe | null>(null);
  const [projects, setProjects] = useState<ProjectWithStats[]>([]);
  const [project, setProjectState] = useState<string | null>(null);
  const [env, setEnvState] = useState(() => localStorage.getItem(ENV_KEY) ?? 'prod');
  const [availableEnvs, setAvailableEnvs] = useState<string[]>(['prod']);

  const setEnv = useCallback((e: string) => {
    localStorage.setItem(ENV_KEY, e);
    setEnvState(e);
  }, []);

  const client = useMemo(
    () => (hostedToken ? new PoolstatisClient(baseUrl, hostedToken) : token ? new PoolstatisClient(baseUrl, token) : null),
    [baseUrl, hostedToken, token],
  );

  const connect = useCallback(async (c: Conn) => {
    const probe = new PoolstatisClient(c.baseUrl, c.token);
    const { projects: list, scope } = await probe.listProjects(); // throws on bad token / unreachable
    localStorage.setItem(LS_KEY, JSON.stringify(c));
    setBaseUrl(c.baseUrl);
    setToken(c.token);
    setHostedToken(null);
    setExplicitKind(kindOf(c.token));
    setProjectScope(scope);
    setAccount(null);
    setProjects(list);
    setProjectState(list[0]?.slug ?? null);
  }, []);

  const connectHosted = useCallback(async (c: HostedConn) => {
    const probe = new PoolstatisClient(c.baseUrl, c.getToken);
    const profile = await probe.me(); // creates/refreshes the hosted user and org.
    const { projects: list, scope } = await probe.listProjects();
    localStorage.removeItem(LS_KEY);
    setBaseUrl(c.baseUrl);
    setToken('');
    setHostedToken(() => c.getToken);
    setExplicitKind('user');
    setProjectScope(scope);
    setAccount(profile);
    setProjects(list);
    setProjectState(list[0]?.slug ?? null);
  }, []);

  const disconnect = useCallback(() => {
    localStorage.removeItem(LS_KEY);
    setToken('');
    setHostedToken(null);
    setExplicitKind(null);
    setProjectScope(null);
    setAccount(null);
    setProjects([]);
    setProjectState(null);
  }, []);

  const refreshProjects = useCallback(async () => {
    if (!client) return;
    const { projects: list, scope } = await client.listProjects();
    setProjects(list);
    setProjectScope(scope);
    setProjectState((p) => p ?? list[0]?.slug ?? null);
  }, [client]);

  const refreshAccount = useCallback(async () => {
    if (!client || explicitKind !== 'user') return;
    setAccount(await client.me());
  }, [client, explicitKind]);

  // Derive which environments actually exist from the selected project's keys
  // (the env switcher hides when there's only one). Falls back to ['prod'].
  useEffect(() => {
    if (!client || !project) return;
    let alive = true;
    client.keys(project)
      .then((keys) => {
        if (!alive) return;
        const envs = [...new Set(keys.filter((k) => !k.revoked_at).map((k) => k.env))];
        setAvailableEnvs(envs.length ? envs.sort() : ['prod']);
      })
      .catch(() => alive && setAvailableEnvs(['prod']));
    return () => { alive = false; };
  }, [client, project]);

  // Re-hydrate the project list when a saved connection exists on first load.
  useEffect(() => {
    if (client && projects.length === 0) {
      client.listProjects()
        .then(({ projects: list, scope }) => {
          setProjects(list);
          setProjectScope(scope);
          setProjectState((p) => p ?? list[0]?.slug ?? null);
        })
        .catch(() => disconnect());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const value: Store = {
    client, baseUrl, token, tokenKind: explicitKind, projectScope, account, projects, project, env, availableEnvs,
    setEnv,
    setProject: setProjectState,
    refreshProjects, refreshAccount,
    connect, connectHosted, disconnect,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useStore(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error('useStore outside provider');
  return s;
}

/** Small async-data hook with loading/error, re-running when deps change. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): {
  data: T | null; error: string | null; loading: boolean; reload: () => void;
} {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    fn()
      .then((d) => alive && setData(d))
      .catch((e) => alive && setError(e?.message ?? 'failed'))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  return { data, error, loading, reload: () => setNonce((n) => n + 1) };
}
