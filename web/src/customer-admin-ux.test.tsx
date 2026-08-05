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
    expect(NAV_ICONS.Setup).toBe(Plug);
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
    await screen.findByRole('heading', { name: 'Connect your product' });
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

    expect(await screen.findByText('What do you want to learn first?')).toBeInTheDocument();
    expect(screen.getByLabelText('Product name')).toBeInTheDocument();
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


describe('server-verified setup flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
    mockedStore.mockReturnValue(baseStore());
  });

  it('shows the three product-connection steps and real server confirmation', async () => {
    renderSetup();

    expect(await screen.findByText('Alpha is connected')).toBeInTheDocument();
    const progress = screen.getByLabelText('Connection progress');
    expect(within(progress).getByText('Product key')).toBeInTheDocument();
    expect(within(progress).getByText('Add Poolstatis')).toBeInTheDocument();
    expect(within(progress).getByText('First event')).toBeInTheDocument();
    expect(screen.getByText(/Poolstatis received a real product event/)).toBeInTheDocument();
    expect(screen.getByText('Connected')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'View MCP setup' })).toBeInTheDocument();
  });

  it('creates a fresh write-only key and copies it as an environment variable', async () => {
    const store = baseStore() as any;
    store.client.issueKey = vi.fn().mockResolvedValue({ token: 'pk_fresh_once' });
    mockedStore.mockReturnValue(store);
    renderSetup();

    await screen.findByText('A product key already exists');
    fireEvent.click(screen.getByRole('button', { name: 'Create fresh key' }));
    await waitFor(() => expect(store.client.issueKey).toHaveBeenCalledWith(
      'alpha',
      { kind: 'ingest', env: 'prod', label: 'Setup guide' },
    ));
    expect(await screen.findByText('Product key ready')).toBeInTheDocument();
    expect(screen.getByText('VITE_POOLSTATIS_INGEST_KEY=pk_••••••••••••')).toBeInTheDocument();
    expect(screen.queryByText('pk_fresh_once')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Copy .env line' }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      'VITE_POOLSTATIS_INGEST_KEY=pk_fresh_once',
    ));
  });

  it('copies one secret-free task that installs all skills and the SDK', async () => {
    renderSetup();
    await screen.findByText('Alpha is connected');

    fireEvent.click(screen.getByRole('button', { name: 'Claude Code' }));
    fireEvent.click(screen.getByRole('button', { name: 'Copy task for Claude Code' }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalled());
    const task = vi.mocked(navigator.clipboard.writeText).mock.calls.at(-1)?.[0] as string;
    expect(task).toContain('poolstatis-instrument poolstatis-analyze poolstatis-maintain');
    expect(task).toContain('@poolstatis/sdk@latest');
    expect(task).toContain('--agent claude-code');
    expect(task).toContain('never ask me to paste a pk_, sk_, or pt_ token into chat');
    expect(task).toContain('MCP is optional');
    expect(task).not.toContain('sk_test');
  });

  it('keeps a complete manual SDK path beside the recommended agent path', async () => {
    renderSetup();
    await screen.findByText('Alpha is connected');

    fireEvent.click(screen.getByRole('button', { name: /Install manually/ }));
    expect(screen.getByText('npm install @poolstatis/sdk@latest')).toBeInTheDocument();
    expect(screen.getByText(/createClient/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'React / Vite' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Node / server' }));
    expect(screen.getByText(/process\.env\.POOLSTATIS_INGEST_KEY/)).toBeInTheDocument();
  });

  it('keeps MCP optional and puts its credential only in the copied settings', async () => {
    renderSetup();
    await screen.findByText('Alpha is connected');

    fireEvent.click(screen.getByRole('button', { name: 'View MCP setup' }));
    expect(screen.getByText('1. Install the Poolstatis skills')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy skills command' })).toBeInTheDocument();
    expect(screen.getAllByText(/Never paste it into chat/).length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText('sk_test')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Copy config for Codex' }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalled());
    const config = vi.mocked(navigator.clipboard.writeText).mock.calls.at(-1)?.[0] as string;
    expect(config).toContain('POOLSTATIS_TOKEN');
    expect(config).toContain('sk_test');
    expect(config).toContain('POOLSTATIS_URL');
  });

  it('lets a hosted user create a dedicated agent token after skipping MCP', async () => {
    const store = baseStore() as any;
    store.tokenKind = 'user';
    store.token = null;
    store.client.issuePersonalToken = vi.fn().mockResolvedValue({ token: 'pt_fresh_once' });
    mockedStore.mockReturnValue(store);
    renderSetup();

    await screen.findByText('Alpha is connected');
    fireEvent.click(screen.getByRole('button', { name: 'View MCP setup' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create agent token' }));
    await waitFor(() => expect(store.client.issuePersonalToken).toHaveBeenCalledWith({ label: 'Codex MCP' }));
    expect(screen.queryByText('pt_fresh_once')).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Copy config for Codex' })).toBeInTheDocument();
  });

  it('renders a proof failure as retryable without claiming a connection', async () => {
    const store = baseStore() as any;
    store.client.onboardingStatus = vi.fn().mockRejectedValue(new Error('proof unavailable'));
    mockedStore.mockReturnValue(store);
    renderSetup();

    expect(await screen.findByRole('alert')).toHaveTextContent('proof unavailable');
    expect(screen.queryByText('Alpha is connected')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check connection' })).toBeInTheDocument();
  });

  it('shows a project-scoped checking state while server proof is pending', async () => {
    const store = baseStore() as any;
    let resolveProof: ((value: typeof proof) => void) | undefined;
    store.client.onboardingStatus = vi.fn().mockReturnValue(new Promise((resolve) => { resolveProof = resolve; }));
    mockedStore.mockReturnValue(store);
    renderSetup();

    expect(screen.getByRole('button', { name: 'Checking…' })).toBeDisabled();
    await act(async () => resolveProof?.(proof));
    expect(await screen.findByText('Alpha is connected')).toBeInTheDocument();
  });

  it('explains that a project must be selected before setup', () => {
    const store = baseStore() as any;
    store.project = null;
    mockedStore.mockReturnValue(store);
    renderSetup();

    expect(screen.getByText('Select a project first.')).toBeInTheDocument();
  });

  it('polls the same server proof until the first event arrives', async () => {
    const pendingProof = {
      ...proof,
      gates: proof.gates.map((item) => item.key === 'first_event_observed'
        ? { ...item, complete: false, evidence: { observation_source: null, native_events: 0, last_seen: null } }
        : item),
    };
    const store = baseStore() as any;
    store.client.onboardingStatus = vi.fn().mockResolvedValue(pendingProof);
    mockedStore.mockReturnValue(store);
    renderSetup();

    expect(await screen.findByText('Waiting for the first event from Alpha…')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Check connection' }));
    await waitFor(() => expect(store.client.onboardingStatus.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it('keeps administration and destructive actions behind one advanced disclosure', async () => {
    renderSetup();
    await screen.findByText('Alpha is connected');

    const advanced = screen.getByText('Advanced setup and administration').closest('details');
    expect(advanced).not.toHaveAttribute('open');
    fireEvent.click(screen.getByText('Advanced setup and administration'));
    expect(advanced).toHaveAttribute('open');
    expect(await screen.findByText('MCP tool groups')).toBeInTheDocument();
    expect(screen.getByText('Which key goes where?')).toBeInTheDocument();
    expect(screen.getByText('Danger zone · prod')).toBeInTheDocument();
    expect(screen.getAllByText('Instrumentation standard').length).toBeGreaterThanOrEqual(1);
  });

  it('shows a safe manual fallback when task copying is blocked', async () => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('blocked')) } });
    renderSetup();
    await screen.findByText('Alpha is connected');

    fireEvent.click(screen.getByRole('button', { name: 'Copy task for Codex' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Select the task below and copy it manually');
    expect(screen.getByText(/Set up Poolstatis analytics in this repository/)).toBeInTheDocument();
    expect(screen.queryByText('sk_test')).not.toBeInTheDocument();
  });
});
