import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PoolstatisClient } from './api/client';
import type { AccountMe, ProjectWithStats } from './api/types';
import { hostedSessionMarkerKey } from './oidc';
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
    personalTokens.mockResolvedValue([{
      id: 'token-1', label: 'CLI', token: 'pt_...cafe', created_at: '2026-07-01T00:00:00.000Z', last_used_at: null, revoked_at: null,
      credential_policy: {
        id: 'poolstatis_core.credential_rotation', version: 1, source: 'poolstatis_core_default', mode: 'advisory',
        thresholds: { age_review_days: 180, idle_review_days: 30, unused_review_days: 7 },
      },
      rotation_recommendation: {
        status: 'review', code: 'unused_review', label: 'Never used',
        recommendation: 'Verify the intended owner or revoke the unused key.',
        evaluated_at: '2026-08-11T00:00:00.000Z', evidence: { age_days: 41, idle_days: null },
      },
    }]);
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
    const projects: ProjectWithStats[] = [{
      slug: 'alpha', name: 'Alpha', timezone: 'UTC', active_metrics: 0, proposed_metrics: 0, active_outcome_contracts: 0, funnels: 0,
      events_24h: 0, events_7d: 0, events_30d: 0, last_event_at: null, registered_coverage_30d: null,
      key_outcome_available: false, health: 'no_data', attention: ['No events in 30 days', 'No active measurement contract'],
      health_evaluation: {
        source: 'server', evaluated_at: '2026-08-11T12:00:00.000Z',
        guardrails: [
          { id: 'recent_data', state: 'fail', observed: 0, expectation: 'More than 0 accepted events in 30 days' },
          { id: 'registered_coverage', state: 'not_applicable', observed: null, expectation: 'Registered coverage is at least 99%' },
          { id: 'active_outcome', state: 'fail', observed: 0, expectation: 'At least 1 active measurement contract' },
          { id: 'metric_review_queue', state: 'pass', observed: 0, expectation: 'No proposed metrics awaiting review' },
        ],
      },
    }];
    me.mockResolvedValue(account('owner'));
    listProjects.mockResolvedValue({ projects, scope: 'org' });
    render(<StoreProvider><StoreProbe onChange={(store) => { current = store; }} /></StoreProvider>);

    await act(async () => { await current!.connectHosted({ baseUrl: 'https://cloud.example.test', getToken }); });

    await waitFor(() => expect(current).toMatchObject({ tokenKind: 'user', projectScope: 'org', projects, project: 'alpha' }));
    expect(listProjects).toHaveBeenCalledOnce();
    expect(localStorage.getItem(hostedSessionMarkerKey)).toBe('connected');
    expect(localStorage.getItem('poolstatis.conn')).toBeNull();
  });
});
