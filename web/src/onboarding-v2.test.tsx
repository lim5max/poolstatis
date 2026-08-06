import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Onboarding } from './screens/Onboarding';
import { Setup } from './screens/Setup';
import { ProductConnectionGuide, type SetupTaskResponse } from './components/ProductConnectionGuide';
import { useStore } from './store';

vi.mock('./store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./store')>()),
  useStore: vi.fn(),
}));

const mockedStore = vi.mocked(useStore);

const pendingProof = {
  complete: false,
  gates: [
    { key: 'data_source_connected', complete: true, required: true, evidence: {}, blocker: null, next_action: null },
    { key: 'first_event_observed', complete: false, required: true, evidence: {}, blocker: 'No event.', next_action: 'Send one event.' },
  ],
  next_blocker: null,
  final_result: null,
};

const connectedProof = {
  complete: false,
  gates: [
    { key: 'data_source_connected', complete: true, required: true, evidence: {}, blocker: null, next_action: null },
    { key: 'agent_connected', complete: false, required: false, evidence: {}, blocker: null, next_action: null },
    {
      key: 'first_event_observed',
      complete: true,
      required: true,
      evidence: {
        event_name: 'page.viewed',
        env: 'prod',
        registered: true,
        last_seen: '2026-08-06T10:00:00.000Z',
      },
      blocker: null,
      next_action: null,
    },
  ],
  next_blocker: null,
  final_result: null,
};

const setupTask = (agentId = 'codex'): SetupTaskResponse => ({
  task: `Set up Poolstatis for ${agentId}. Never request pk_, sk_, or pt_ credentials.`,
  source: 'deterministic',
  plan: {
    release_manifest: { sdk: '@poolstatis/sdk@0.3.0' },
    smoke_action: 'Open one real page.',
  },
});

describe('Product Experience V2 onboarding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
  });

  it('uses native keyboard/screen-reader controls and validates bounded multi-select goals', () => {
    mockedStore.mockReturnValue({
      account: { organization: { name: 'Acme' } },
      client: {},
      baseUrl: 'https://api.poolstatis.test',
      refreshProjects: vi.fn(),
      setProject: vi.fn(),
    } as never);

    render(<MemoryRouter><Onboarding /></MemoryRouter>);

    const productMode = screen.getByRole('radio', { name: /^A product/ });
    productMode.focus();
    expect(productMode).toHaveFocus();
    expect(productMode).toHaveAttribute('type', 'radio');
    fireEvent.click(productMode);
    expect(productMode).toBeChecked();
    expect(screen.queryByLabelText(/Domain/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    const custom = screen.getByRole('checkbox', { name: 'Something else' });
    expect(custom).toHaveAttribute('type', 'checkbox');
    fireEvent.click(custom);
    expect(custom).toBeChecked();
    expect(screen.getByRole('button', { name: 'Create project' })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('at least 10 characters');

    const customGoal = screen.getByLabelText('Describe the decision you want to make.');
    expect(customGoal).toHaveAttribute('maxlength', '500');
    fireEvent.change(customGoal, { target: { value: 'Understand docs activation' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Find where users get stuck' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Know which features matter' }));
    expect(screen.getByText('3 of 3 selected')).toHaveAttribute('aria-live', 'polite');
    expect(screen.getByRole('checkbox', { name: 'Understand retention' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Create project' })).toBeEnabled();
  });

  it('creates website intent atomically, separates the key from the server task, and routes on server proof', async () => {
    let connected = false;
    const completeOnboarding = vi.fn().mockResolvedValue({
      organization: { id: 'org-1', name: 'Acme' },
      project: { slug: 'docs', name: 'Docs', timezone: 'UTC' },
      tokens: { personal: 'pt_onetime_private', ingest_prod: 'pk_onetime_private' },
      mcp: {
        command: 'pnpm', args: [], package_status: 'published', note: '',
        env: { POOLSTATIS_URL: 'https://api.poolstatis.test', POOLSTATIS_TOKEN: 'pt_onetime_private' },
      },
    });
    const onboardingStatus = vi.fn().mockImplementation(() => Promise.resolve(connected ? connectedProof : pendingProof));
    const requestTask = vi.fn().mockImplementation((_slug, body: { agent_id: string }) => Promise.resolve(setupTask(body.agent_id)));
    const refreshProjects = vi.fn().mockResolvedValue(undefined);
    const setProject = vi.fn();
    mockedStore.mockReturnValue({
      account: { organization: { name: 'Acme' } },
      client: { completeOnboarding, onboardingStatus, setupTask: requestTask },
      baseUrl: 'https://api.poolstatis.test',
      refreshProjects,
      setProject,
    } as never);

    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<Onboarding />} />
          <Route path="/analyze/web" element={<div>Website destination</div>} />
        </Routes>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('radio', { name: /^A website/ }));
    fireEvent.change(screen.getByLabelText(/Domain/), { target: { value: 'Docs.Example.com' } });
    fireEvent.change(screen.getByLabelText('Project name'), { target: { value: 'Docs' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'See who visits my website' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Improve signup or lead conversion' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }));

    await waitFor(() => expect(completeOnboarding).toHaveBeenCalledWith({
      workspace_name: 'Acme',
      project_name: 'Docs',
      project_slug: 'docs',
      project_mode: 'website',
      goal_ids: ['website_traffic', 'website_conversion'],
      custom_goal: null,
      primary_goal_id: 'website_traffic',
      website_domain: 'docs.example.com',
    }));
    expect(await screen.findByText('Product key ready')).toBeInTheDocument();
    expect(screen.queryByText('pk_onetime_private')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Copy .env line' }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith('VITE_POOLSTATIS_INGEST_KEY=pk_onetime_private'));
    expect(await screen.findByRole('radio', { name: 'Codex' })).toBeChecked();
    await waitFor(() => expect(requestTask).toHaveBeenCalledWith('docs', { agent_id: 'codex', prefer_llm: false }));
    fireEvent.click(screen.getByRole('radio', { name: 'Claude Code' }));
    await waitFor(() => expect(requestTask).toHaveBeenCalledWith('docs', { agent_id: 'claude-code', prefer_llm: false }));
    fireEvent.click(await screen.findByRole('button', { name: 'Copy setup task' }));

    const copiedTask = vi.mocked(navigator.clipboard.writeText).mock.calls.at(-1)?.[0] as string;
    expect(copiedTask).toContain('Set up Poolstatis for claude-code');
    expect(copiedTask).not.toContain('pk_onetime_private');
    expect(copiedTask).not.toContain('pt_onetime_private');
    expect(await screen.findByText('Waiting for your first event…')).toHaveAttribute('id', 'waiting-title');

    connected = true;
    fireEvent.click(screen.getByRole('button', { name: 'Check now' }));
    expect(await screen.findByText('Event received')).toBeInTheDocument();
    expect(screen.getByText('Let your agent answer questions')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open website overview' }));
    expect(await screen.findByText('Website destination')).toBeInTheDocument();
    expect(setProject).toHaveBeenCalledWith('docs');
    expect(refreshProjects).toHaveBeenCalledOnce();
  });

  it('shows a selectable fallback when clipboard permission is denied and does not regenerate on rerender', async () => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('blocked')) } });
    const requestTask = vi.fn().mockResolvedValue(setupTask());
    const props = {
      ingestKey: 'pk_private_value',
      serverUrl: 'https://api.poolstatis.test',
      projectName: 'Alpha',
      projectSlug: 'alpha',
      eventSeen: false,
      getSetupTask: requestTask,
      onCheck: vi.fn(),
    };
    const view = render(<ProductConnectionGuide {...props} />);

    fireEvent.click(screen.getByRole('button', { name: 'Copy .env line' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Select the content below');
    expect(screen.getByText('VITE_POOLSTATIS_INGEST_KEY=pk_private_value')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'I saved it' }));
    expect(await screen.findByRole('radio', { name: 'Codex' })).toBeChecked();
    await waitFor(() => expect(requestTask).toHaveBeenCalledOnce());

    view.rerender(<ProductConnectionGuide {...props} checking />);
    await waitFor(() => expect(requestTask).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: 'Copy setup task' }));
    expect((await screen.findAllByRole('alert')).at(-1)).toHaveTextContent('Select the content below');
    expect(screen.getByText(setupTask().task)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'I copied it' }));
    expect(await screen.findByText('Waiting for your first event…')).toBeInTheDocument();
  });

  it('reports an unregistered received event as attention without making MCP a setup error', () => {
    const review = vi.fn();
    render(
      <ProductConnectionGuide
        ingestKey={null}
        keyReady
        serverUrl="https://api.poolstatis.test"
        projectName="Alpha"
        projectSlug="alpha"
        projectMode="product"
        eventSeen
        eventName="checkout.finished"
        eventEnvironment="prod"
        eventRegistered={false}
        onCheck={vi.fn()}
        onOpenProject={vi.fn()}
        onReviewMetrics={review}
        onConnectMcp={vi.fn()}
      />,
    );

    expect(screen.getByText('Event received')).toBeInTheDocument();
    expect(screen.getByText('Needs attention')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Review proposed metrics' }));
    expect(review).toHaveBeenCalledOnce();
    expect(screen.getByText('Let your agent answer questions')).toBeInTheDocument();
    expect(screen.getByText('Optional')).toBeInTheDocument();
  });
});

describe('condensed Setup', () => {
  it('keeps a connected legacy project usable with four compact rows and optional MCP', async () => {
    mockedStore.mockReturnValue({
      client: {
        onboardingStatus: vi.fn().mockResolvedValue(connectedProof),
        projectIntent: vi.fn().mockResolvedValue({ intent: null }),
      },
      baseUrl: 'https://api.poolstatis.test',
      token: 'sk_private',
      tokenKind: 'secret',
      projects: [{ slug: 'alpha', name: 'Alpha', timezone: 'UTC', active_metrics: 0, funnels: 0, events_30d: 1 }],
      project: 'alpha',
      env: 'prod',
    } as never);

    render(<MemoryRouter><Setup /></MemoryRouter>);

    expect(await screen.findByRole('heading', { name: 'Setup' })).toBeInTheDocument();
    expect(screen.getAllByText(/Connected/).length).toBeGreaterThan(0);
    const rows = screen.getByLabelText('Setup status');
    expect(within(rows).getByText('Product connection')).toBeInTheDocument();
    expect(within(rows).getByText('Tracking plan')).toBeInTheDocument();
    expect(within(rows).getByText('Agent access')).toBeInTheDocument();
    expect(within(rows).getByText('Destinations & advanced')).toBeInTheDocument();
    expect(screen.getByText('Existing projects keep working without choosing a mode.')).toBeInTheDocument();
    expect(screen.queryByText('No events yet')).not.toBeInTheDocument();

    fireEvent.click(within(rows).getByRole('button', { name: 'Connect' }));
    expect(screen.getByText('Let your agent answer questions')).toBeInTheDocument();
    expect(screen.getByText('Connect MCP so your agent can read analytics and manage Poolstatis.')).toBeInTheDocument();
  });
});
