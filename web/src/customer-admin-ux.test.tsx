import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App, NAV_ICONS, usageNavigationSignal } from './App';
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
      metrics: vi.fn().mockResolvedValue([]),
      operationalQuery: vi.fn().mockResolvedValue({
        kind: 'actors',
        actors: [],
        meta: {
          computed_at: '2026-08-06T00:00:00.000Z',
          date_range: { from: '2026-07-07T00:00:00.000Z', to: '2026-08-06T00:00:00.000Z' },
          sampling: null,
          source: 'native',
          limit: 50,
          order: 'last_seen_desc',
          next_cursor: null,
          activity_metric: null,
          capabilities: {
            property_filters: { available: false, reason: 'No canonical actor-property source.' },
            pinned_properties: { available: false, reason: 'No approved pinned-property source.' },
            session_count: {
              source: 'canonical_browser_sessions',
              unavailable_value: null,
              project_capability: false,
            },
            identity_profile: { available: false, reason: 'Only explicit identity links are available.' },
            outcome_rank: { available: false, reason: 'No purpose-backed outcome is selected.' },
            interesting_categories: {
              recently_activated: { available: false, requires: 'purpose_backed_activation_metric_or_funnel' },
              stalled: { available: false, requires: 'purpose_backed_stall_definition' },
              at_risk: { available: false, requires: 'purpose_backed_risk_definition' },
              changed_segment: { available: false, requires: 'trusted_canonical_actor_property_source' },
            },
          },
          provenance: {
            identity_status: 'Only explicit links are classified.',
            top_events: { registered_only: true, limit: 8 },
            pinned_properties: { source: null, fail_closed: true },
            ordering: {
              selected: 'last_seen_desc',
              input: 'last_seen',
              relative_to: 'the exact query window',
            },
          },
        },
      }),
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

  it('keeps every Data & settings route reachable when the desktop navigation is collapsed', async () => {
    render(<MemoryRouter><App /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: 'Collapse navigation' }));
    fireEvent.keyDown(screen.getByRole('button', { name: 'Data & settings' }), { key: 'ArrowDown' });

    for (const name of ['Definitions', 'Events', 'Registry', 'Experience', 'Experiments', 'Decisions', 'Automations', 'Keys']) {
      expect(await screen.findByRole('menuitem', { name })).toBeInTheDocument();
    }
  });

  it('provides one focusable route heading for control screens that do not own a visible title', async () => {
    render(<MemoryRouter initialEntries={['/data']}><App /></MemoryRouter>);

    const heading = await screen.findByRole('heading', { name: 'Events', level: 1 });
    await waitFor(() => expect(heading).toHaveFocus());
  });

  it('keeps answer jobs primary and control surfaces behind Data & settings', () => {
    render(<MemoryRouter><App /></MemoryRouter>);
    expect(screen.getAllByText('Home').length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText('Answers')).not.toBeInTheDocument();
    expect(screen.getByText('Data & settings')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /^(Home|Web|Product|Funnels|Saved|People|Ship|Usage|Setup)$/ })).toHaveLength(9);
    expect(screen.getByRole('link', { name: 'Funnels' })).toHaveAttribute('href', '/analyze/funnels');
    expect(screen.getByRole('link', { name: 'Saved' })).toHaveAttribute('href', '/analyze/saved');
    const settings = screen.getByText('Data & settings').closest('details');
    expect(settings).not.toBeNull();
    fireEvent.click(screen.getByText('Data & settings'));
    expect(screen.getByRole('link', { name: 'Automations' })).toHaveAttribute('href', '/automation');
    expect(within(settings!).queryByRole('link', { name: 'Profile' })).not.toBeInTheDocument();
    expect(within(screen.getByLabelText('Account navigation')).getByRole('link', { name: 'Profile' })).toHaveAttribute('href', '/profile');
  });

  it('preserves the selected analytics range across analytics navigation', () => {
    render(<MemoryRouter initialEntries={['/?range=custom&from=2026-08-17&to=2026-08-18']}><App /></MemoryRouter>);

    expect(screen.getByRole('link', { name: 'Web' })).toHaveAttribute(
      'href',
      '/analyze/web?range=custom&from=2026-08-17&to=2026-08-18',
    );
    expect(screen.getByRole('link', { name: 'Product' })).toHaveAttribute(
      'href',
      '/analyze/product?range=custom&from=2026-08-17&to=2026-08-18',
    );
    expect(screen.getByRole('link', { name: 'Funnels' })).toHaveAttribute(
      'href',
      '/analyze/funnels?range=custom&from=2026-08-17&to=2026-08-18',
    );
    expect(screen.getByRole('link', { name: 'People' })).toHaveAttribute(
      'href',
      '/analyze/users?range=custom&from=2026-08-17&to=2026-08-18',
    );
    expect(screen.getByRole('link', { name: 'Saved' })).toHaveAttribute('href', '/analyze/saved');
  });

  it('keeps an unfinished project recoverable after the user navigates away from onboarding', async () => {
    const current = baseStore() as any;
    current.envReady = true;
    current.client.onboardingStatus = vi.fn().mockResolvedValue({
      ...proof,
      gates: proof.gates.map((gate) => (
        gate.key === 'data_source_connected' || gate.key === 'first_event_observed'
          ? { ...gate, complete: false }
          : gate
      )),
    });
    mockedStore.mockReturnValue(current);

    render(<MemoryRouter initialEntries={['/analyze/users']}><App /></MemoryRouter>);

    const resume = await screen.findByRole('region', { name: 'Finish project setup' });
    expect(resume).toHaveTextContent('Create and save a product key');
    expect(screen.getByRole('link', { name: 'Open Setup' })).toHaveAttribute('href', '/setup');
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
    expect(screen.getByRole('link', { name: 'Funnels' })).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /^(Home|Web|Funnels|Saved|People|Ship|Usage|Setup)$/ })).toHaveLength(8);
  });

  it('shows server-owned attention and finite usage signals in the shell', async () => {
    const current = baseStore() as any;
    current.client.controlTower = vi.fn().mockResolvedValue({
      attention: [
        { id: 'a1', state: 'open' },
        { id: 'a2', state: 'open' },
        { id: 'a3', state: 'resolved' },
      ],
    });
    current.client.usageControl = vi.fn().mockResolvedValue({
      cap: { state: 'finite', value: 1_000, remaining: 200 },
      answer: { primary_value: { value: 800 } },
    });
    mockedStore.mockReturnValue(current);

    render(<MemoryRouter><App /></MemoryRouter>);

    const home = screen.getByRole('link', { name: 'Home' });
    await waitFor(() => expect(within(home).getByRole('status', { name: 'Home status: 2' })).toBeInTheDocument());
    const usageLink = screen.getByRole('link', { name: 'Usage' });
    const usageSignal = within(usageLink).getByRole('status', { name: 'Usage status: 80%' });
    expect(usageSignal).toHaveClass('text-amber-700');
  });

  it('keeps an unconfigured cap neutral and names only real cycle volume', () => {
    expect(usageNavigationSignal({
      cap: { state: 'not_configured', value: null, remaining: null },
      answer: { primary_value: { value: 1_234 } },
    } as never)).toEqual({ label: '1.2k this cycle', tone: 'neutral' });
  });

  it('keeps unavailable entitlement evidence out of the neutral no-cap state', () => {
    expect(usageNavigationSignal({
      cap: { state: 'unavailable', value: null, remaining: null },
      answer: { state: 'unavailable', primary_value: null },
    } as never)).toEqual({ label: 'Unavailable', tone: 'warning' });
  });

  it('treats a zero hard cap as reached instead of showing zero percent', () => {
    expect(usageNavigationSignal({
      cap: { state: 'finite', value: 0, remaining: 0 },
      answer: { primary_value: { value: 0 } },
    } as never)).toEqual({ label: '100%', tone: 'danger' });
  });

  it('uses semantic Hugeicons and readable neutral hover text', () => {
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
    expect(product).toHaveClass('hover:bg-sidebar-accent/10', 'hover:text-sidebar-foreground');
    expect(product).not.toHaveClass('hover:text-sidebar-accent');

    const dataAndSettings = screen.getByText('Data & settings').closest('summary');
    expect(dataAndSettings).toHaveClass('hover:text-sidebar-foreground');
    expect(dataAndSettings).not.toHaveClass('hover:text-sidebar-accent');

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
    expect(dialog).toHaveClass('!inset-0', '!h-dvh', '!w-screen', '!max-w-none', '!translate-x-0', '!translate-y-0', 'bg-sidebar');
    expect(dialog).not.toHaveClass('w-80', 'shadow-xl');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Navigation' })).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it('moves keyboard focus to the main content after route navigation', async () => {
    render(<MemoryRouter initialEntries={['/analyze/web']}><App /></MemoryRouter>);
    const usage = screen.getAllByRole('link', { name: 'Usage' })[0]!;
    usage.focus();
    fireEvent.click(usage);

    const main = document.getElementById('main-content');
    await waitFor(() => expect(main).toHaveFocus());
    expect(main).toHaveAttribute('tabindex', '-1');
  });
});
