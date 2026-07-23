import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PoolstatisClient } from './api/client';
import type { AccountMe, ProjectWithStats } from './api/types';
import { Profile } from './screens/Profile';
import { StoreProvider, useStore } from './store';

vi.mock('@auth0/auth0-react', () => ({ useAuth0: () => ({ logout: vi.fn() }) }));

function account(role: AccountMe['membership']['role']): AccountMe {
  return {
    user: {
      id: 'user-1', subject: 'auth0|user-1', email: `${role}@example.test`, email_verified: true,
      display_name: role, name: role, picture_url: null, connection_strategy: 'google-oauth2',
    },
    identity: { issuer: 'https://example.auth0.com/', subject: 'auth0|user-1' },
    organization: { id: 'org-1', name: 'Acme', role },
    membership: { organization_id: 'org-1', role },
    billing: {} as AccountMe['billing'],
    onboarding: { completed: true },
  };
}

function StoreProbe({ onChange }: { onChange: (store: ReturnType<typeof useStore>) => void }) {
  const store = useStore();
  onChange(store);
  return <output data-testid="store-state">{JSON.stringify({ scope: store.projectScope, projects: store.projects.map((project) => project.slug), kind: store.tokenKind })}</output>;
}

describe('hosted StoreProvider connection', () => {
  const getToken = vi.fn().mockResolvedValue('access-token');
  const me = vi.spyOn(PoolstatisClient.prototype, 'me');
  const listProjects = vi.spyOn(PoolstatisClient.prototype, 'listProjects');
  const personalTokens = vi.spyOn(PoolstatisClient.prototype, 'personalTokens');
  let current: ReturnType<typeof useStore> | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    current = null;
    localStorage.clear();
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
});
