import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PoolstatisClient } from './api/client';
import type { AccountMe, ProjectWithStats } from './api/types';
import { Profile } from './screens/Profile';
import { StoreProvider, useStore } from './store';

vi.mock('./oidc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./oidc')>()),
  useHostedAuth: () => ({ logout: vi.fn() }),
}));

function account(role: AccountMe['membership']['role']): AccountMe {
  return {
    user: {
      id: 'user-1', subject: 'better-auth-user-1', email: `${role}@example.test`, email_verified: true,
      display_name: role, name: role, picture_url: null, connection_strategy: 'google-oauth2',
    },
    identity: { issuer: 'https://auth.poolstatis.xyz', subject: 'better-auth-user-1' },
    organization: { id: 'org-1', name: 'Acme', role },
    membership: { organization_id: 'org-1', role },
    billing: {} as AccountMe['billing'],
    onboarding: { completed: true },
  };
}

function StoreProbe({ onChange }: { onChange: (store: ReturnType<typeof useStore>) => void }) {
  const store = useStore();
  onChange(store);
  return <output data-testid="store-state">{JSON.stringify({
    scope: store.projectScope,
    projects: store.projects.map((project) => project.slug),
    project: store.project,
    env: store.env,
    kind: store.tokenKind,
  })}</output>;
}

describe('hosted StoreProvider connection', () => {
  const getToken = vi.fn().mockResolvedValue('access-token');
  const me = vi.spyOn(PoolstatisClient.prototype, 'me');
  const listProjects = vi.spyOn(PoolstatisClient.prototype, 'listProjects');
  const personalTokens = vi.spyOn(PoolstatisClient.prototype, 'personalTokens');
  const keys = vi.spyOn(PoolstatisClient.prototype, 'keys');
  let current: ReturnType<typeof useStore> | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    current = null;
    localStorage.clear();
    keys.mockResolvedValue([]);
    personalTokens.mockResolvedValue([{ id: 'token-1', label: 'CLI', token: 'pt_...cafe', created_at: '2026-07-01T00:00:00.000Z', last_used_at: null, revoked_at: null }]);
  });

  it('keeps a hosted member connected without requesting organization projects, including later hydration', async () => {
    me.mockResolvedValue(account('member'));
    render(<StoreProvider><StoreProbe onChange={(store) => { current = store; }} /><Profile /></StoreProvider>);

    await act(async () => { await current!.connectHosted({ baseUrl: 'https://cloud.example.test', getToken }); });

    await screen.findByText('member@example.test');
    await screen.findByText('pt_...cafe');
    expect(current).toMatchObject({ tokenKind: 'user', projectScope: 'org', projects: [], project: null });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(listProjects).not.toHaveBeenCalled();
  });

  it('hydrates projects for a hosted owner after verifying the hosted profile', async () => {
    const projects: ProjectWithStats[] = [{ slug: 'alpha', name: 'Alpha', timezone: 'UTC', active_metrics: 0, funnels: 0, events_30d: 0 }];
    me.mockResolvedValue(account('owner'));
    listProjects.mockResolvedValue({ projects, scope: 'org' });
    render(<StoreProvider><StoreProbe onChange={(store) => { current = store; }} /></StoreProvider>);

    await act(async () => { await current!.connectHosted({ baseUrl: 'https://cloud.example.test', getToken }); });

    await waitFor(() => expect(current).toMatchObject({ tokenKind: 'user', projectScope: 'org', projects, project: 'alpha' }));
    expect(listProjects).toHaveBeenCalledOnce();
  });

  it('restores and persists a selected project only when it is available', async () => {
    const projects: ProjectWithStats[] = [
      { slug: 'alpha', name: 'Alpha', timezone: 'UTC', active_metrics: 0, funnels: 0, events_30d: 0 },
      { slug: 'bravo', name: 'Bravo', timezone: 'UTC', active_metrics: 0, funnels: 0, events_30d: 0 },
    ];
    localStorage.setItem('poolstatis.project', 'bravo');
    me.mockResolvedValue(account('owner'));
    listProjects.mockResolvedValue({ projects, scope: 'org' });
    render(<StoreProvider><StoreProbe onChange={(store) => { current = store; }} /></StoreProvider>);

    await act(async () => { await current!.connectHosted({ baseUrl: 'https://cloud.example.test', getToken }); });
    await waitFor(() => expect(current?.project).toBe('bravo'));

    await act(async () => {
      current!.setProject('alpha');
      await Promise.resolve();
    });
    expect(current?.project).toBe('alpha');
    expect(localStorage.getItem('poolstatis.project')).toBe('alpha');
  });

  it('falls back to an available environment after switching project context', async () => {
    const projects: ProjectWithStats[] = [{ slug: 'alpha', name: 'Alpha', timezone: 'UTC', active_metrics: 0, funnels: 0, events_30d: 0 }];
    localStorage.setItem('poolstatis.env', 'staging');
    me.mockResolvedValue(account('owner'));
    listProjects.mockResolvedValue({ projects, scope: 'org' });
    keys.mockResolvedValue([{ id: 'key-1', kind: 'ingest', env: 'prod', label: null, created_at: '2026-07-01T00:00:00.000Z', revoked_at: null }] as never);
    render(<StoreProvider><StoreProbe onChange={(store) => { current = store; }} /></StoreProvider>);

    await act(async () => { await current!.connectHosted({ baseUrl: 'https://cloud.example.test', getToken }); });

    await waitFor(() => expect(current).toMatchObject({ project: 'alpha', env: 'prod', availableEnvs: ['prod'] }));
    expect(localStorage.getItem('poolstatis.env')).toBe('prod');
  });
});
