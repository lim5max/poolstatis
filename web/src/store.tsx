import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { PoolstatisClient } from './api/client';
import type { KeyKind, ProjectWithStats } from './api/types';

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
  projects: ProjectWithStats[];
  project: string | null;
  env: string;
  envReady: boolean;
  envError: string | null;
  availableEnvs: string[];
  setEnv: (e: string) => void;
  setProject: (slug: string) => void;
  retryEnvValidation: () => void;
  refreshProjects: () => Promise<void>;
  connect: (c: Conn) => Promise<void>;
  connectHosted: (c: HostedConn) => Promise<void>;
  disconnect: () => void;
}

const ENV_KEY = 'poolstatis.env';
const PROJECT_KEY = 'poolstatis.project';
const projectEnvKey = (slug: string) => `${ENV_KEY}.${slug}`;

export function normalizeProjectEnv(current: string, available: string[]): string {
  if (available.includes(current)) return current;
  if (available.includes('prod')) return 'prod';
  return available[0] ?? 'prod';
}

export async function loadProjectEnvironments(
  fetchKeys: () => Promise<Array<{ env: string; revoked_at?: string | null }>>,
): Promise<string[]> {
  const keys = await fetchKeys();
  const environments = [...new Set(keys.filter((key) => !key.revoked_at).map((key) => key.env))];
  return environments.length ? environments.sort() : ['prod'];
}

function savedProjectEnv(slug: string | null): string {
  if (!slug) return 'prod';
  return localStorage.getItem(projectEnvKey(slug)) ?? localStorage.getItem(ENV_KEY) ?? 'prod';
}

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
  const [projects, setProjects] = useState<ProjectWithStats[]>([]);
  const [project, setProjectState] = useState<string | null>(() => localStorage.getItem(PROJECT_KEY));
  const [env, setEnvState] = useState(() => savedProjectEnv(localStorage.getItem(PROJECT_KEY)));
  const [envReady, setEnvReady] = useState(false);
  const [envError, setEnvError] = useState<string | null>(null);
  const [availableEnvs, setAvailableEnvs] = useState<string[]>([]);
  const [envValidationNonce, setEnvValidationNonce] = useState(0);

  const setEnv = useCallback((e: string) => {
    if (project) localStorage.setItem(projectEnvKey(project), e);
    setEnvState(e);
  }, [project]);

  const setProject = useCallback((slug: string) => {
    localStorage.setItem(PROJECT_KEY, slug);
    setEnvState(savedProjectEnv(slug));
    setAvailableEnvs([]);
    setEnvReady(false);
    setEnvError(null);
    setProjectState(slug);
  }, []);

  const retryEnvValidation = useCallback(() => {
    setEnvError(null);
    setEnvReady(false);
    setEnvValidationNonce((current) => current + 1);
  }, []);

  const client = useMemo(
    () => (hostedToken ? new PoolstatisClient(baseUrl, hostedToken) : token ? new PoolstatisClient(baseUrl, token) : null),
    [baseUrl, hostedToken, token],
  );

  const connect = useCallback(async (c: Conn) => {
    const probe = new PoolstatisClient(c.baseUrl, c.token);
    const { projects: list } = await probe.listProjects(); // throws on bad token / unreachable
    localStorage.setItem(LS_KEY, JSON.stringify(c));
    setBaseUrl(c.baseUrl);
    setToken(c.token);
    setHostedToken(null);
    setExplicitKind(kindOf(c.token));
    setProjects(list);
    const savedProject = localStorage.getItem(PROJECT_KEY);
    const nextProject = list.some((item) => item.slug === savedProject) ? savedProject : list[0]?.slug ?? null;
    if (nextProject) localStorage.setItem(PROJECT_KEY, nextProject);
    setEnvState(savedProjectEnv(nextProject));
    setAvailableEnvs([]);
    setEnvReady(false);
    setEnvError(null);
    setProjectState(nextProject);
  }, []);

  const connectHosted = useCallback(async (c: HostedConn) => {
    const probe = new PoolstatisClient(c.baseUrl, c.getToken);
    await probe.me(); // creates/refreshes the hosted user and org.
    const { projects: list } = await probe.listProjects();
    localStorage.removeItem(LS_KEY);
    setBaseUrl(c.baseUrl);
    setToken('');
    setHostedToken(() => c.getToken);
    setExplicitKind('user');
    setProjects(list);
    const savedProject = localStorage.getItem(PROJECT_KEY);
    const nextProject = list.some((item) => item.slug === savedProject) ? savedProject : list[0]?.slug ?? null;
    if (nextProject) localStorage.setItem(PROJECT_KEY, nextProject);
    setEnvState(savedProjectEnv(nextProject));
    setAvailableEnvs([]);
    setEnvReady(false);
    setEnvError(null);
    setProjectState(nextProject);
  }, []);

  const disconnect = useCallback(() => {
    localStorage.removeItem(LS_KEY);
    setToken('');
    setHostedToken(null);
    setExplicitKind(null);
    setProjects([]);
    setProjectState(null);
    setAvailableEnvs([]);
    setEnvReady(false);
    setEnvError(null);
  }, []);

  const refreshProjects = useCallback(async () => {
    if (!client) return;
    const { projects: list } = await client.listProjects();
    setProjects(list);
    setProjectState((current) => {
      const next = list.some((item) => item.slug === current) ? current : list[0]?.slug ?? null;
      if (next) localStorage.setItem(PROJECT_KEY, next);
      if (next !== current) {
        setEnvState(savedProjectEnv(next));
        setAvailableEnvs([]);
        setEnvReady(false);
        setEnvError(null);
      }
      return next;
    });
  }, [client]);

  // Derive environments from a successful key-list response. An empty list
  // means a new project and defaults to prod; request failures remain blocked.
  useEffect(() => {
    if (!client || !project) {
      setEnvReady(false);
      return;
    }
    let alive = true;
    setEnvReady(false);
    setEnvError(null);
    loadProjectEnvironments(() => client.keys(project))
      .then((available) => {
        if (!alive) return;
        setAvailableEnvs(available);
        setEnvState((current) => {
          const next = normalizeProjectEnv(current, available);
          localStorage.setItem(projectEnvKey(project), next);
          return next;
        });
        setEnvReady(true);
      })
      .catch(() => {
        if (!alive) return;
        setAvailableEnvs([]);
        setEnvError('Could not verify this project’s environments.');
        setEnvReady(false);
      });
    return () => { alive = false; };
  }, [client, project, envValidationNonce]);

  // Re-hydrate the project list when a saved connection exists on first load.
  useEffect(() => {
    if (client && projects.length === 0) {
      client.listProjects()
        .then(({ projects: list }) => {
          setProjects(list);
          setProjectState((current) => {
            const next = list.some((item) => item.slug === current) ? current : list[0]?.slug ?? null;
            if (next) localStorage.setItem(PROJECT_KEY, next);
            if (next !== current) {
              setEnvState(savedProjectEnv(next));
              setAvailableEnvs([]);
              setEnvReady(false);
              setEnvError(null);
            }
            return next;
          });
        })
        .catch(() => disconnect());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const value: Store = {
    client, baseUrl, token, tokenKind: explicitKind, projects, project, env, envReady, envError, availableEnvs,
    setEnv,
    setProject,
    retryEnvValidation,
    refreshProjects,
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
