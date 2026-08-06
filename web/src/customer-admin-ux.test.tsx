import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App, NAV_ICONS } from './App';
import { useStore } from './store';
import {
  Browser,
  Catalogue,
  ChartAnalysis,
  DashboardSpeed,
  GitCommit,
  Globe,
  Plug,
  Ruler,
  TaskDone,
  TestTube,
  UserCircle,
  UserGroup,
} from './components/icons';

vi.mock('./store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./store')>()),
  useStore: vi.fn(),
}));
vi.mock('./oidc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./oidc')>()),
  hostedAuthEnabled: false,
  useHostedAuth: () => ({ logout: vi.fn() }),
}));

const mockedStore = vi.mocked(useStore);
const proof = {
  complete: false,
  gates: [
    { key: 'workspace_created', complete: true, required: true, evidence: { project: 'alpha' }, blocker: null, next_action: null },
    { key: 'agent_connected', complete: true, required: false, evidence: { client: 'codex', observed_at: '2026-07-26T18:30:00.000Z' }, blocker: null, next_action: null },
    { key: 'data_source_connected', complete: true, required: true, evidence: { native: true, posthog: false, native_key_created_at: '2026-07-26T18:28:00.000Z' }, blocker: null, next_action: null },
    { key: 'first_event_observed', complete: true, required: true, evidence: { observation_source: 'native', native_events: 12, last_seen: '2026-07-26T18:32:00.000Z', posthog_query_at: null }, blocker: null, next_action: null },
    { key: 'metrics_activated', complete: false, required: true, evidence: {}, blocker: 'No active metric has verified source evidence.', next_action: 'Review and activate a metric.' },
    { key: 'data_quality_accepted', complete: true, required: true, evidence: { issues: 0 }, blocker: null, next_action: null },
    { key: 'first_query_produced', complete: true, required: true, evidence: { query_run_id: 'q1', source: 'native', created_at: '2026-07-26T18:35:00.000Z' }, blocker: null, next_action: null },
    { key: 'first_decision_saved', complete: false, required: true, evidence: {}, blocker: 'No decision saved.', next_action: 'Save a decision.' },
  ],
  next_blocker: { key: 'metrics_activated', complete: false, evidence: {}, blocker: 'No active metric has verified source evidence.', next_action: 'Review and activate a metric.' },
  final_result: null,
} as const;

function baseStore() {
  return {
    client: {
      onboardingStatus: vi.fn().mockResolvedValue(proof),
      standard: vi.fn().mockResolvedValue('Instrumentation standard'),
      webhookDestinations: vi.fn().mockResolvedValue([]),
    },
    baseUrl: 'https://api.poolstatis.test',
    token: 'sk_test',
    tokenKind: 'secret',
    projects: [{ slug: 'alpha', name: 'Alpha', timezone: 'UTC', active_metrics: 0, funnels: 0, events_30d: 0 }],
    project: 'alpha',
    env: 'prod',
    setProject: vi.fn(),
    disconnect: vi.fn(),
  } as never;
}

describe('customer admin shell', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mockedStore.mockReturnValue(baseStore());
  });

  it('collapses the desktop navigation and persists the choice', () => {
    const view = render(<MemoryRouter><App /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: 'Collapse navigation' }));
    expect(screen.getByRole('button', { name: 'Expand navigation' })).toBeInTheDocument();
    expect(localStorage.getItem('poolstatis.sidebar.collapsed')).toBe('true');

    view.unmount();
    render(<MemoryRouter><App /></MemoryRouter>);
    expect(screen.getByRole('button', { name: 'Expand navigation' })).toBeInTheDocument();
  });

  it('keeps answer jobs primary and control surfaces behind Data & settings', () => {
    render(<MemoryRouter><App /></MemoryRouter>);
    expect(screen.getAllByText('Home').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('Answers')).toBeInTheDocument();
    expect(screen.getByText('Data & settings')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /^(Home|Web|Product|People|Ship|Setup)$/ })).toHaveLength(6);
  });

  it('adapts primary navigation to the persisted project mode', async () => {
    const current = baseStore() as any;
    current.client.projectIntent = vi.fn().mockResolvedValue({
      intent: { project_mode: 'website', goal_ids: ['website_traffic'], primary_goal_id: 'website_traffic' },
    });
    mockedStore.mockReturnValue(current);

    render(<MemoryRouter><App /></MemoryRouter>);

    await waitFor(() => expect(screen.queryByRole('link', { name: 'Product' })).not.toBeInTheDocument());
    expect(screen.getByRole('link', { name: 'Web' })).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /^(Home|Web|People|Ship|Setup)$/ })).toHaveLength(5);
  });

  it('uses semantic Hugeicons and a restrained lime hover state', () => {
    render(<MemoryRouter initialEntries={['/analyze/web']}><App /></MemoryRouter>);

    expect(NAV_ICONS.Product).toBe(ChartAnalysis);
    expect(NAV_ICONS.Web).toBe(Globe);
    expect(NAV_ICONS.People).toBe(UserGroup);
    expect(NAV_ICONS.Ship).toBe(GitCommit);
    expect(NAV_ICONS.Experiments).toBe(TestTube);
    expect(NAV_ICONS.Decisions).toBe(TaskDone);
    expect(NAV_ICONS.Registry).toBe(Catalogue);
    expect(NAV_ICONS.Definitions).toBe(Ruler);
    expect(NAV_ICONS.Experience).toBe(Browser);
    expect(NAV_ICONS.Setup).toBe(Plug);
    expect(NAV_ICONS.Usage).toBe(DashboardSpeed);
    expect(NAV_ICONS.Profile).toBe(UserCircle);

    const product = screen.getAllByRole('link', { name: 'Product' })[0];
    expect(product).toHaveClass('hover:bg-sidebar-accent/10', 'hover:text-sidebar-accent');
    expect(product).not.toHaveClass('hover:text-foreground');

    const web = screen.getAllByRole('link', { name: 'Web' })[0];
    expect(web).toHaveClass('bg-sidebar-accent', 'text-sidebar-accent-foreground');
  });

  it('keeps the project and environment visible on Setup', async () => {
    render(<MemoryRouter initialEntries={['/setup']}><App /></MemoryRouter>);
    await screen.findByRole('heading', { name: 'Setup' });
    expect(screen.getByRole('button', { name: /alpha/i })).toBeInTheDocument();
    expect(screen.getByText('Alpha · prod')).toBeInTheDocument();
    expect(screen.queryByText('Connect an agent, send data, and verify the first query.')).not.toBeInTheDocument();
  });

  it('routes a new hosted owner with no projects into first-project onboarding', async () => {
    mockedStore.mockReturnValue({
      ...(baseStore() as any),
      tokenKind: 'user',
      projects: [],
      project: null,
      account: {
        organization: { id: 'org-new', name: 'Lion workspace' },
        membership: { organization_id: 'org-new', role: 'owner' },
      },
      client: { completeOnboarding: vi.fn() },
      refreshProjects: vi.fn(),
    } as never);

    render(<MemoryRouter initialEntries={['/']}><App /></MemoryRouter>);

    expect(await screen.findByText('What are you connecting?')).toBeInTheDocument();
    expect(screen.getByLabelText('Project name')).toBeInTheDocument();
    expect(screen.queryByText('No project selected')).not.toBeInTheDocument();
  });

  it('keeps the project context and project management reachable from Analyze', async () => {
    render(<MemoryRouter initialEntries={['/analyze/product']}><App /></MemoryRouter>);
    const projectSwitcher = screen.getByRole('button', { name: /alpha/i });
    expect(projectSwitcher).toBeInTheDocument();
    expect(screen.getAllByText('prod').length).toBeGreaterThan(0);
    fireEvent.keyDown(projectSwitcher, { key: 'ArrowDown' });
    expect(await screen.findByRole('menuitem', { name: 'Manage projects' })).toBeInTheDocument();
  });

  it('still works when browser storage is blocked', () => {
    const read = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    render(<MemoryRouter><App /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: 'Collapse navigation' }));
    expect(screen.getByRole('button', { name: 'Expand navigation' })).toBeInTheDocument();
    read.mockRestore();
    write.mockRestore();
  });

  it('opens the mobile navigation, closes it with Escape, and restores focus', async () => {
    render(<MemoryRouter><App /></MemoryRouter>);
    const trigger = screen.getByRole('button', { name: 'Open navigation' });
    fireEvent.click(trigger);
    const dialog = await screen.findByRole('dialog', { name: 'Navigation' });
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Navigation' })).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });
});
