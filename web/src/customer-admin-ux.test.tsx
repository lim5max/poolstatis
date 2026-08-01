import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App, NAV_ICONS } from './App';
import { Setup } from './screens/Setup';
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
const renderSetup = () => render(<MemoryRouter><Setup /></MemoryRouter>);

const proof = {
  complete: false,
  gates: [
    { key: 'workspace_created', complete: true, evidence: { project: 'alpha' }, blocker: null, next_action: null },
    { key: 'agent_connected', complete: true, evidence: { client: 'codex', observed_at: '2026-07-26T18:30:00.000Z' }, blocker: null, next_action: null },
    { key: 'data_source_connected', complete: true, evidence: { native: true, posthog: false, native_key_created_at: '2026-07-26T18:28:00.000Z' }, blocker: null, next_action: null },
    { key: 'first_event_observed', complete: true, evidence: { observation_source: 'native', native_events: 12, last_seen: '2026-07-26T18:32:00.000Z', posthog_query_at: null }, blocker: null, next_action: null },
    { key: 'metrics_activated', complete: false, evidence: {}, blocker: 'No active metric has verified source evidence.', next_action: 'Review and activate a metric.' },
    { key: 'data_quality_accepted', complete: true, evidence: { issues: 0 }, blocker: null, next_action: null },
    { key: 'first_query_produced', complete: true, evidence: { query_run_id: 'q1', source: 'native', created_at: '2026-07-26T18:35:00.000Z' }, blocker: null, next_action: null },
    { key: 'first_decision_saved', complete: false, evidence: {}, blocker: 'No decision saved.', next_action: 'Save a decision.' },
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

  it('groups navigation around overview, analysis, decisions, data management, and account tasks', () => {
    render(<MemoryRouter><App /></MemoryRouter>);
    expect(screen.getAllByText('Overview').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('Analyze')).toBeInTheDocument();
    expect(screen.getByText('Ship & decide')).toBeInTheDocument();
    expect(screen.getByText('Manage data')).toBeInTheDocument();
    expect(screen.getByText('Workspace')).toBeInTheDocument();
  });

  it('uses semantic Hugeicons and a restrained lime hover state', () => {
    render(<MemoryRouter initialEntries={['/analyze/web']}><App /></MemoryRouter>);

    expect(NAV_ICONS['Product analytics']).toBe(ChartAnalysis);
    expect(NAV_ICONS['Web analytics']).toBe(Globe);
    expect(NAV_ICONS.Users).toBe(UserGroup);
    expect(NAV_ICONS.Changes).toBe(GitCommit);
    expect(NAV_ICONS.Experiments).toBe(TestTube);
    expect(NAV_ICONS.Decisions).toBe(TaskDone);
    expect(NAV_ICONS.Registry).toBe(Catalogue);
    expect(NAV_ICONS.Measurement).toBe(Ruler);
    expect(NAV_ICONS['Browser experience']).toBe(Browser);
    expect(NAV_ICONS['Setup & MCP']).toBe(Plug);
    expect(NAV_ICONS.Usage).toBe(DashboardSpeed);
    expect(NAV_ICONS.Profile).toBe(UserCircle);

    const product = screen.getAllByRole('link', { name: 'Product analytics' })[0];
    expect(product).toHaveClass('hover:bg-sidebar-accent/10', 'hover:text-sidebar-accent');
    expect(product).not.toHaveClass('hover:text-foreground');

    const web = screen.getAllByRole('link', { name: 'Web analytics' })[0];
    expect(web).toHaveClass('bg-sidebar-accent', 'text-sidebar-accent-foreground');
  });

  it('keeps the project and environment visible on Setup', async () => {
    render(<MemoryRouter initialEntries={['/setup']}><App /></MemoryRouter>);
    await screen.findByText('Project created');
    expect(screen.getByRole('button', { name: /alpha/i })).toBeInTheDocument();
    expect(screen.getAllByText('prod').length).toBeGreaterThan(0);
    expect(screen.queryByText('Connect an agent, send data, and verify the first query.')).not.toBeInTheDocument();
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

describe('server-verified setup flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
    mockedStore.mockReturnValue(baseStore());
  });

  it('shows a compact count, one next action, and all eight checks on demand', async () => {
    renderSetup();
    expect(await screen.findByText('Project created')).toBeInTheDocument();
    expect(screen.getByText('of 8')).toBeInTheDocument();
    expect(screen.getByText('Data source ready')).toBeInTheDocument();
    expect(screen.getByText('First product observation')).toBeInTheDocument();
    expect(screen.getByText('First query produced')).toBeInTheDocument();
    expect(screen.getByText('Last MCP-marked use')).toBeInTheDocument();
    expect(screen.getAllByText('Review and activate a metric.')).toHaveLength(1);
    expect(screen.queryByText('MCP connected')).not.toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'All setup checks' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^View all 8 checks/ }));
    const allChecks = screen.getByRole('list', { name: 'All setup checks' });
    expect(within(allChecks).getAllByRole('listitem')).toHaveLength(8);
    expect(within(allChecks).getByText(/Codex/i)).toBeInTheDocument();
  });

  it('shows client logos in one chooser and reuses the selected agent below', async () => {
    renderSetup();
    await screen.findByText('Last MCP-marked use');
    const chooser = screen.getByRole('button', { name: 'Coding agent: Claude Code' });
    expect(within(chooser).getByLabelText('Claude Code logo')).toHaveAttribute('data-brand-logo', 'claude-code');
    expect(screen.getByRole('button', { name: 'Copy Claude Code install' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy Codex install' })).not.toBeInTheDocument();
  });

  it('leads with four intents and keeps manual controls behind recovery disclosure', async () => {
    renderSetup();
    await screen.findByText('Last MCP-marked use');
    for (const job of ['Understand activation', 'Find funnel drop-off', 'Add web analytics', 'Measure a release']) {
      expect(screen.getByRole('button', { name: new RegExp(job) })).toBeInTheDocument();
    }
    expect(screen.getByRole('heading', { name: 'Prerequisite 1 · Agent connection' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Prerequisite 2 · Poolstatis skills' })).toBeInTheDocument();
    expect(screen.getByText('Give this to your agent')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy request' })).toBeInTheDocument();
    expect(screen.queryByText(/Before editing:/)).not.toBeInTheDocument();
    expect(screen.queryByText('Activate a metric before sending')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show manual setup and recovery' }));
    expect(screen.getByText('Activate a metric before sending')).toBeInTheDocument();
    expect(screen.getByText(/not a heartbeat or transport attestation/i)).toBeInTheDocument();
  });

  it('copies the selected agent three-skill install command without credentials or an unpublished SDK', async () => {
    renderSetup();
    await screen.findByRole('heading', { name: 'Prerequisite 2 · Poolstatis skills' });
    expect(screen.getByText('poolstatis-instrument')).toBeInTheDocument();
    expect(screen.getByText('poolstatis-analyze')).toBeInTheDocument();
    expect(screen.getByText('poolstatis-maintain')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Copy Claude Code install' }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      expect.stringContaining('https://github.com/lim5max/poolstatis'),
    ));
    const copied = vi.mocked(navigator.clipboard.writeText).mock.calls.at(-1)?.[0] as string;
    expect(copied).toContain('--agent');
    expect(copied).toContain('claude-code');
    expect(copied).toContain('poolstatis-instrument');
    expect(copied).toContain('poolstatis-analyze');
    expect(copied).toContain('poolstatis-maintain');
    expect(copied).not.toContain('POOLSTATIS_TOKEN');
    expect(copied).not.toContain('@poolstatis/sdk');
  });

  it('offers focused first-query prompts and copies the selected variant', async () => {
    renderSetup();
    await screen.findByText('Last MCP-marked use');
    fireEvent.click(screen.getByRole('button', { name: 'Show manual setup and recovery' }));
    expect(screen.getByRole('button', { name: 'Quick trend' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Compare periods' }));
    expect(screen.getByRole('button', { name: 'Compare periods' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText(/preceding 7 days/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Copy compare periods prompt' }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      expect.stringContaining('Do not claim causality'),
    ));
  });

  it('renders server-proof failure as retryable without implying a connection', async () => {
    const store = baseStore() as any;
    store.client.onboardingStatus = vi.fn().mockRejectedValue(new Error('proof unavailable'));
    mockedStore.mockReturnValue(store);
    renderSetup();
    expect(await screen.findByRole('alert')).toHaveTextContent('proof unavailable');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.queryByText('MCP connected')).not.toBeInTheDocument();
  });

  it('shows a project-scoped loading state while server proof is pending', async () => {
    const store = baseStore() as any;
    let resolveProof: ((value: typeof proof) => void) | undefined;
    store.client.onboardingStatus = vi.fn().mockReturnValue(new Promise((resolve) => { resolveProof = resolve; }));
    mockedStore.mockReturnValue(store);
    renderSetup();
    expect(screen.getByText('Checking setup proof…')).toBeInTheDocument();
    await act(async () => resolveProof?.(proof));
    expect(await screen.findByText('Project created')).toBeInTheDocument();
  });

  it('explains the empty proof state when no project is selected', async () => {
    const store = baseStore() as any;
    store.project = null;
    mockedStore.mockReturnValue(store);
    renderSetup();
    expect(await screen.findByText('Choose a project to read its setup proof.')).toBeInTheDocument();
  });

  it('treats copied config as local progress, not a verified connection', async () => {
    renderSetup();
    await screen.findByText('Last MCP-marked use');
    fireEvent.click(screen.getByRole('button', { name: 'Copy MCP config' }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalled());
    const copied = vi.mocked(navigator.clipboard.writeText).mock.calls.at(-1)?.[0] as string;
    expect(copied).toContain('<replace-with-pt-or-sk>');
    expect(copied).not.toContain('sk_test');
    await waitFor(() => expect(screen.getByText('Connection values copied. This action does not verify MCP use.')).toBeInTheDocument());
    expect(screen.getByText('Last MCP-marked use')).toBeInTheDocument();
  });

  it('generates one scoped intent request without session or MCP credentials', async () => {
    renderSetup();
    await screen.findByText('Last MCP-marked use');
    fireEvent.click(screen.getByRole('button', { name: /Find funnel drop-off/ }));
    fireEvent.change(screen.getByLabelText('Product-specific outcome · optional'), { target: { value: 'More teams finish checkout' } });
    const requestPanel = screen.getByText('Give this to your agent').closest('[data-slot="card"]');
    expect(requestPanel).not.toBeNull();
    fireEvent.click(within(requestPanel as HTMLElement).getByRole('button', { name: 'Copy request' }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalled());
    const copied = vi.mocked(navigator.clipboard.writeText).mock.calls.at(-1)?.[0] as string;
    expect(copied).toContain('project "alpha" in environment "prod"');
    expect(copied).toContain('Product outcome: More teams finish checkout');
    expect(copied).not.toContain('sk_test');
    expect(copied).not.toContain('<replace-with-pt-or-sk>');
  });

  it('keeps reference material and destructive actions behind progressive disclosure', async () => {
    renderSetup();
    await screen.findByText('Add analytics with your agent');
    expect(screen.getByRole('button', { name: 'Show advanced setup' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('MCP tool reference')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show advanced setup' }));
    expect(screen.getByText('MCP tool reference')).toBeInTheDocument();
    expect(screen.getByText('Data deletion')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('reading webhook status…')).not.toBeInTheDocument());
  });

  it('advertises only tools present in the pinned public runner contract', async () => {
    renderSetup();
    await screen.findByText('Add analytics with your agent');
    fireEvent.click(screen.getByRole('button', { name: 'Show advanced setup' }));
    for (const tool of [
      'get_web_overview',
      'list_web_sessions',
      'get_web_session',
      'get_session_engagement',
      'get_page_engagement',
      'preview_event_backfill',
      'import_historical_events',
      'list_event_backfills',
      'preview_event_revision',
      'revise_event',
      'get_event_history',
    ]) {
      expect(screen.getByText(tool, { exact: true })).toBeInTheDocument();
    }
    for (const tool of [
      'list_metric_categories',
      'create_metric_category',
      'update_metric_category',
      'delete_metric_category',
      'get_click_map',
      'get_scroll_map',
    ]) {
      expect(screen.queryByText(tool, { exact: true })).not.toBeInTheDocument();
    }
    await waitFor(() => expect(screen.queryByText('reading webhook status…')).not.toBeInTheDocument());
  });

  it('reveals a manual fallback when clipboard access is blocked', async () => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('blocked')) } });
    renderSetup();
    await screen.findByText('Last MCP-marked use');
    fireEvent.click(screen.getByRole('button', { name: 'Copy MCP config' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Copy blocked');
    expect(screen.getByRole('button', { name: 'Hide config and client steps' })).toBeInTheDocument();
  });

  it('labels PostHog-only evidence without claiming native accepted events', async () => {
    const posthogProof = {
      ...proof,
      gates: proof.gates.map((item) => item.key === 'first_event_observed'
        ? {
            ...item,
            evidence: {
              observation_source: 'posthog',
              native_events: 0,
              last_seen: null,
              posthog_query_at: '2026-07-26T18:32:00.000Z',
            },
          }
        : item),
    };
    const store = baseStore() as any;
    store.client.onboardingStatus = vi.fn().mockResolvedValue(posthogProof);
    mockedStore.mockReturnValue(store);
    renderSetup();
    await screen.findByText('First product observation');
    fireEvent.click(screen.getByRole('button', { name: /^View all 8 checks/ }));
    expect(screen.getByText(/PostHog query/)).toBeInTheDocument();
    expect(screen.queryByText(/0 accepted/)).not.toBeInTheDocument();
  });
});
