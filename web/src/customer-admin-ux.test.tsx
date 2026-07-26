import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { Setup } from './screens/Setup';
import { useStore } from './store';

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
  next_blocker: null,
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

  it('groups navigation around setup, measurement, delivery, and account tasks', () => {
    render(<MemoryRouter><App /></MemoryRouter>);
    expect(screen.getByText('Get started')).toBeInTheDocument();
    expect(screen.getByText('Measure')).toBeInTheDocument();
    expect(screen.getByText('Ship & learn')).toBeInTheDocument();
    expect(screen.getByText('Workspace')).toBeInTheDocument();
  });

  it('keeps the project and environment visible on Setup', async () => {
    render(<MemoryRouter initialEntries={['/setup']}><App /></MemoryRouter>);
    await screen.findByText('Project created');
    expect(screen.getByRole('button', { name: /alpha/i })).toBeInTheDocument();
    expect(screen.getByText('prod')).toBeInTheDocument();
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

  it('shows concise proof statuses with timestamps from persisted server evidence', async () => {
    renderSetup();
    expect(await screen.findByText('Project created')).toBeInTheDocument();
    expect(screen.getByText('Ingest key created')).toBeInTheDocument();
    expect(screen.getByText('First accepted event')).toBeInTheDocument();
    expect(screen.getByText('First query completed')).toBeInTheDocument();
    expect(screen.getByText('MCP request last recorded')).toBeInTheDocument();
    expect(screen.getAllByText(/Codex/i).length).toBeGreaterThan(0);
    expect(screen.queryByText('MCP connected')).not.toBeInTheDocument();
  });

  it('treats copied config as local progress, not a verified connection', async () => {
    renderSetup();
    await screen.findByText('MCP request last recorded');
    fireEvent.click(screen.getByRole('button', { name: 'Copy MCP config' }));
    await waitFor(() => expect(screen.getByText('Config copied. This action does not verify MCP use.')).toBeInTheDocument());
    expect(screen.getByText('MCP request last recorded')).toBeInTheDocument();
  });

  it('keeps reference material and destructive actions behind progressive disclosure', async () => {
    renderSetup();
    await screen.findByText('Connect Poolstatis in four steps');
    expect(screen.getByRole('button', { name: 'Show advanced setup' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('MCP tool reference')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show advanced setup' }));
    expect(screen.getByText('MCP tool reference')).toBeInTheDocument();
    expect(screen.getByText('Data deletion')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('reading webhook status…')).not.toBeInTheDocument());
  });

  it('reveals a manual fallback when clipboard access is blocked', async () => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('blocked')) } });
    renderSetup();
    await screen.findByText('MCP request last recorded');
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
    expect(await screen.findByText('External observation verified')).toBeInTheDocument();
    expect(screen.getByText(/PostHog query/)).toBeInTheDocument();
    expect(screen.queryByText(/0 accepted/)).not.toBeInTheDocument();
  });
});
