import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Onboarding } from './screens/Onboarding';
import { Setup } from './screens/Setup';
import { ProductConnectionGuide, type SetupTaskResponse } from './components/ProductConnectionGuide';
import { useStore } from './store';

const { telemetryCapture } = vi.hoisted(() => ({ telemetryCapture: vi.fn() }));

vi.mock('./store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./store')>()),
  useStore: vi.fn(),
}));

vi.mock('./productTelemetry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./productTelemetry')>()),
  captureProductTelemetry: telemetryCapture,
}));

const mockedStore = vi.mocked(useStore);
const telemetryEvents = (name: string) => telemetryCapture.mock.calls.filter(([event]) => event === name);

const pendingProof = {
  complete: false,
  gates: [
    { key: 'data_source_connected', complete: true, required: true, evidence: {}, blocker: null, next_action: null },
    { key: 'first_event_observed', complete: false, required: true, evidence: {}, blocker: 'No event.', next_action: 'Send one event.' },
  ],
  next_blocker: { key: 'first_event_observed', complete: false, required: true, evidence: {}, blocker: 'No event.', next_action: 'Send one event.' },
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

const setupTask = (agentId = 'codex', blocker: string | null = null): SetupTaskResponse => ({
  task: `Set up Poolstatis for ${agentId}. Never request pk_, sk_, or pt_ credentials.`,
  source: 'deterministic',
  blocker,
  plan: {
    release_manifest: { sdk: '@poolstatis/sdk@0.3.0' },
    smoke_action: 'Open one real page.',
  },
});

describe('Product Experience V2 onboarding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.sessionStorage.clear();
    window.localStorage.clear();
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
  });

  it('presents six clear goal cards and keeps multi-select bounded and reversible', () => {
    mockedStore.mockReturnValue({
      account: { organization: { name: 'Acme' }, user: { id: 'user-1' } },
      client: {},
      baseUrl: 'https://api.poolstatis.test',
      refreshProjects: vi.fn(),
      setProject: vi.fn(),
    } as never);

    render(<MemoryRouter><Onboarding /></MemoryRouter>);

    const websiteSurface = screen.getByRole('checkbox', { name: /^A website/ });
    const productSurface = screen.getByRole('checkbox', { name: /^A product/ });
    websiteSurface.focus();
    expect(websiteSurface).toHaveFocus();
    expect(websiteSurface).toHaveAttribute('type', 'checkbox');
    fireEvent.click(websiteSurface);
    fireEvent.click(productSurface);
    expect(websiteSurface).toBeChecked();
    expect(productSurface).toBeChecked();
    expect(telemetryEvents('onboarding.mode_selected')).toEqual([
      ['onboarding.mode_selected', { mode: 'website' }, { distinctId: 'user-1' }],
      ['onboarding.mode_selected', { mode: 'both' }, { distinctId: 'user-1' }],
    ]);
    expect(screen.getByLabelText(/Domain/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(screen.getByRole('heading', { name: 'What do you want to understand first?' })).toBeInTheDocument();
    expect(screen.getByText('Choose up to 3. We’ll prepare the right setup.')).toBeInTheDocument();
    const goalGrid = screen.getByRole('group', { name: 'Analytics goals' });
    expect(within(goalGrid).getAllByRole('checkbox')).toHaveLength(6);
    expect(screen.getByText('You can add more tracking later.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue with 0 goals' })).toBeDisabled();

    const journey = screen.getByRole('checkbox', { name: 'Track a customer journey' });
    const traffic = screen.getByRole('checkbox', { name: 'Understand website traffic' });
    const usage = screen.getByRole('checkbox', { name: 'See what people use' });
    const outcome = screen.getByRole('checkbox', { name: 'Track a key outcome' });
    expect(journey).toHaveAttribute('type', 'checkbox');
    expect(journey.closest('label')).toHaveAttribute('aria-pressed', 'false');
    journey.focus();
    expect(journey).toHaveFocus();

    fireEvent.click(journey);
    fireEvent.click(traffic);
    fireEvent.click(usage);
    expect(journey.closest('label')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('3 goals selected')).toHaveAttribute('aria-live', 'polite');
    expect(outcome).toBeDisabled();

    fireEvent.click(journey);
    expect(journey).not.toBeChecked();
    expect(outcome).toBeEnabled();
    expect(screen.getByText('2 goals selected')).toHaveAttribute('aria-live', 'polite');
    expect(screen.getByRole('button', { name: 'Continue with 2 goals' })).toBeEnabled();
    expect(telemetryEvents('onboarding.goals_selected').at(-1)?.[1]).toEqual({
      goal_ids: ['website_traffic', 'feature_adoption'],
    });
  });

  it('creates a minimal starter intent when the user is not sure yet', async () => {
    const completeOnboarding = vi.fn().mockResolvedValue({
      organization: { id: 'org-1', name: 'Acme' },
      project: { slug: 'starter', name: 'Starter', timezone: 'UTC' },
      tokens: { personal: null, ingest_prod: 'pk_starter_private' },
      mcp: { command: 'pnpm', args: [], package_status: 'published', note: '', env: {} },
    });
    mockedStore.mockReturnValue({
      account: { organization: { name: 'Acme' }, user: { id: 'user-starter' } },
      client: {
        completeOnboarding,
        onboardingStatus: vi.fn().mockResolvedValue(pendingProof),
        setupTask: vi.fn().mockResolvedValue(setupTask()),
      },
      baseUrl: 'https://api.poolstatis.test',
      refreshProjects: vi.fn().mockResolvedValue(undefined),
      setProject: vi.fn(),
    } as never);

    render(<MemoryRouter><Onboarding /></MemoryRouter>);
    fireEvent.click(screen.getByRole('checkbox', { name: /^A product/ }));
    fireEvent.change(screen.getByLabelText('Project name'), { target: { value: 'Starter' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'I’m not sure yet' }));

    await waitFor(() => expect(completeOnboarding).toHaveBeenCalledWith(expect.objectContaining({
      project_mode: 'product',
      goal_ids: ['activation'],
      primary_goal_id: 'activation',
      custom_goal: null,
    })));
  });

  it('derives the backwards-compatible both mode from two checked surfaces', async () => {
    const completeOnboarding = vi.fn().mockResolvedValue({
      organization: { id: 'org-1', name: 'Acme' },
      project: { slug: 'combined', name: 'Combined', timezone: 'UTC' },
      tokens: { personal: null, ingest_prod: 'pk_combined_private' },
      mcp: { command: 'pnpm', args: [], package_status: 'published', note: '', env: {} },
    });
    mockedStore.mockReturnValue({
      account: { organization: { name: 'Acme' }, user: { id: 'user-both' } },
      client: {
        completeOnboarding,
        onboardingStatus: vi.fn().mockResolvedValue(pendingProof),
        setupTask: vi.fn().mockResolvedValue(setupTask()),
      },
      baseUrl: 'https://api.poolstatis.test',
      refreshProjects: vi.fn().mockResolvedValue(undefined),
      setProject: vi.fn(),
    } as never);

    render(<MemoryRouter><Onboarding /></MemoryRouter>);
    fireEvent.click(screen.getByRole('checkbox', { name: /^A website/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /^A product/ }));
    fireEvent.change(screen.getByLabelText('Project name'), { target: { value: 'Combined' } });
    fireEvent.change(screen.getByLabelText(/Domain/), { target: { value: 'combined.example' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Understand website traffic' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Track a customer journey' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue with 2 goals' }));

    await waitFor(() => expect(completeOnboarding).toHaveBeenCalledWith({
      workspace_name: 'Acme',
      project_name: 'Combined',
      project_slug: 'combined',
      issue_personal_token: false,
      project_mode: 'both',
      goal_ids: ['website_traffic', 'activation'],
      custom_goal: null,
      primary_goal_id: 'website_traffic',
      website_domain: 'combined.example',
    }));
  });

  it('keeps a manually cleared slug editable and does not overwrite it from the project name', () => {
    mockedStore.mockReturnValue({
      account: { organization: { name: 'Acme' }, user: { id: 'user-slug' } },
      client: {},
      baseUrl: 'https://api.poolstatis.test',
      refreshProjects: vi.fn(),
      setProject: vi.fn(),
    } as never);

    render(<MemoryRouter><Onboarding /></MemoryRouter>);
    fireEvent.click(screen.getByRole('checkbox', { name: /^A product/ }));
    fireEvent.click(screen.getByText('Advanced'));

    const slug = screen.getByLabelText('Project slug');
    fireEvent.change(slug, { target: { value: '' } });
    fireEvent.change(slug, { target: { value: 'custom-' } });
    expect(slug).toHaveValue('custom-');
    expect(slug).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent('end with a letter or number');

    fireEvent.change(slug, { target: { value: 'custom-slug' } });
    expect(slug).toHaveValue('custom-slug');
    expect(slug).toHaveAttribute('aria-invalid', 'false');
    fireEvent.change(screen.getByLabelText('Project name'), { target: { value: 'Renamed project' } });
    expect(slug).toHaveValue('custom-slug');
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
      account: { organization: { name: 'Acme' }, user: { id: 'user-2' } },
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

    fireEvent.click(screen.getByRole('checkbox', { name: /^A website/ }));
    fireEvent.change(screen.getByLabelText(/Domain/), { target: { value: 'Docs.Example.com' } });
    fireEvent.change(screen.getByLabelText('Project name'), { target: { value: 'Docs' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Understand website traffic' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Track a customer journey' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue with 2 goals' }));

    await waitFor(() => expect(completeOnboarding).toHaveBeenCalledWith({
      workspace_name: 'Acme',
      project_name: 'Docs',
      project_slug: 'docs',
      issue_personal_token: false,
      project_mode: 'website',
      goal_ids: ['website_traffic', 'website_conversion'],
      custom_goal: null,
      primary_goal_id: 'website_traffic',
      website_domain: 'docs.example.com',
    }));
    expect(await screen.findByText('Save your product key')).toBeInTheDocument();
    expect(screen.queryByText('pk_onetime_private')).not.toBeInTheDocument();
    expect(telemetryEvents('onboarding.key_copied')).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Copy .env line' }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith('VITE_POOLSTATIS_INGEST_KEY=pk_onetime_private'));
    expect(telemetryEvents('onboarding.key_copied')).toEqual([
      ['onboarding.key_copied', { environment: 'prod', method: 'clipboard' }, { distinctId: 'user-2' }],
    ]);
    fireEvent.click(await screen.findByRole('button', { name: 'I saved .env.local' }));
    expect(await screen.findByRole('radio', { name: 'Codex' })).toBeChecked();
    const installationPack = screen.getByLabelText('Installation pack');
    expect(within(installationPack).getByRole('list')).toHaveTextContent('Understand website traffic');
    expect(within(installationPack).getByRole('list')).toHaveTextContent('Track a customer journey');
    expect(within(installationPack).getAllByText('People')).toHaveLength(1);
    expect(within(installationPack).getByText('Web')).toBeInTheDocument();
    expect(within(installationPack).getByText('Funnels')).toBeInTheDocument();
    await waitFor(() => expect(requestTask).toHaveBeenCalledWith('docs', { agent_id: 'codex', prefer_llm: false }));
    fireEvent.click(screen.getByRole('radio', { name: 'Claude Code' }));
    await waitFor(() => expect(requestTask).toHaveBeenCalledWith('docs', { agent_id: 'claude-code', prefer_llm: false }));
    fireEvent.click(await screen.findByRole('button', { name: 'Copy setup task' }));

    const copiedTask = vi.mocked(navigator.clipboard.writeText).mock.calls.at(-1)?.[0] as string;
    expect(copiedTask).toContain('Set up Poolstatis for claude-code');
    expect(copiedTask).not.toContain('pk_onetime_private');
    expect(copiedTask).not.toContain('pt_onetime_private');
    await waitFor(() => expect(telemetryEvents('onboarding.task_copied').at(-1)).toEqual([
      'onboarding.task_copied', { agent_id: 'claude-code', method: 'clipboard' }, { distinctId: 'user-2' },
    ]));
    expect(telemetryEvents('onboarding.task_generated').at(-1)?.[1]).toMatchObject({ source: 'deterministic' });
    expect(await screen.findByText('Waiting for your first event…')).toHaveAttribute('id', 'waiting-title');

    connected = true;
    fireEvent.click(screen.getByRole('button', { name: 'Check now' }));
    expect(await screen.findByText('Event received')).toBeInTheDocument();
    expect(screen.getByLabelText('Installation pack')).toHaveTextContent('Understand website traffic');
    expect(screen.getByLabelText('Installation pack')).toHaveTextContent('Track a customer journey');
    await waitFor(() => expect(telemetryEvents('onboarding.first_event_received')).toHaveLength(1));
    expect(telemetryEvents('onboarding.completed')).toHaveLength(1);
    expect(screen.getByText('Let your agent answer questions')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open website overview' }));
    expect(await screen.findByText('Website destination')).toBeInTheDocument();
    expect(setProject).toHaveBeenCalledWith('docs');
    expect(refreshProjects).toHaveBeenCalledOnce();
  });

  it('requests an LLM-preferred setup task only after a custom goal is persisted', async () => {
    const requestTask = vi.fn().mockResolvedValue(setupTask());
    mockedStore.mockReturnValue({
      account: { organization: { name: 'Acme' }, user: { id: 'user-3' } },
      client: {
        completeOnboarding: vi.fn().mockResolvedValue({
          organization: { id: 'org-1', name: 'Acme' },
          project: { slug: 'custom-project', name: 'Custom project', timezone: 'UTC' },
          tokens: { personal: 'pt_private_once', ingest_prod: 'pk_private_once' },
          mcp: { command: 'pnpm', args: [], package_status: 'published', note: '', env: {} },
        }),
        onboardingStatus: vi.fn().mockResolvedValue(pendingProof),
        setupTask: requestTask,
      },
      baseUrl: 'https://api.poolstatis.test',
      refreshProjects: vi.fn().mockResolvedValue(undefined),
      setProject: vi.fn(),
    } as never);

    render(<MemoryRouter><Onboarding /></MemoryRouter>);
    fireEvent.click(screen.getByRole('checkbox', { name: /^A product/ }));
    fireEvent.change(screen.getByLabelText('Project name'), { target: { value: 'Custom project' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Something else' }));
    fireEvent.change(screen.getByLabelText('Describe the decision you want to make.'), {
      target: { value: 'Understand successful workspace activation' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue with 1 goal' }));
    await waitFor(() => expect(telemetryEvents('onboarding.custom_goal_submitted')).toEqual([
      ['onboarding.custom_goal_submitted', { length_bucket: '10_to_49' }, { distinctId: 'user-3' }],
    ]));
    expect(JSON.stringify(telemetryCapture.mock.calls)).not.toContain('Understand successful workspace activation');
    fireEvent.click(await screen.findByRole('button', { name: 'Copy .env line' }));
    fireEvent.click(await screen.findByRole('button', { name: 'I saved .env.local' }));

    await waitFor(() => expect(requestTask).toHaveBeenCalledWith('custom-project', {
      agent_id: 'codex',
      prefer_llm: true,
    }));
  });

  it('explains where to save the copied key and lets the user reopen that step', async () => {
    const requestTask = vi.fn().mockResolvedValue(setupTask());
    render(
      <ProductConnectionGuide
        ingestKey="pk_private_value"
        serverUrl="https://api.poolstatis.test"
        projectName="Alpha"
        projectSlug="alpha"
        projectMode="product"
        eventSeen={false}
        getSetupTask={requestTask}
        onCheck={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Copy .env line' }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith('VITE_POOLSTATIS_INGEST_KEY=pk_private_value'));

    expect(screen.getByText(/Open or create .env.local in your project root/)).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: 'Codex' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'I saved .env.local' }));
    expect(await screen.findByRole('radio', { name: 'Codex' })).toBeChecked();

    fireEvent.click(screen.getByRole('button', { name: 'Back to product key' }));
    expect(screen.getByRole('heading', { name: 'Save your product key' })).toBeInTheDocument();
    expect(screen.getByText(/Open or create .env.local in your project root/)).toBeInTheDocument();
  });

  it('lets the user return from first-event waiting and copy the same agent task again', async () => {
    const requestTask = vi.fn().mockResolvedValue(setupTask());
    render(
      <ProductConnectionGuide
        ingestKey={null}
        keyReady
        serverUrl="https://api.poolstatis.test"
        projectName="Alpha"
        projectSlug="alpha"
        projectMode="product"
        eventSeen={false}
        getSetupTask={requestTask}
        onCheck={vi.fn()}
      />,
    );

    expect(await screen.findByRole('button', { name: 'Copy setup task' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Copy setup task' }));
    expect(await screen.findByText('Waiting for your first event…')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Back to agent task' }));
    expect(await screen.findByRole('button', { name: 'Copy setup task' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Copy setup task' }));

    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(2));
    expect(requestTask).toHaveBeenCalledTimes(1);
    expect(vi.mocked(navigator.clipboard.writeText).mock.calls[0]?.[0]).toBe(setupTask().task);
    expect(vi.mocked(navigator.clipboard.writeText).mock.calls[1]?.[0]).toBe(setupTask().task);
  });

  it('shows deliberate manual-check progress and an explicit no-event result', async () => {
    const onCheck = vi.fn().mockResolvedValue(undefined);
    const props = {
      ingestKey: null,
      keyReady: true,
      serverUrl: 'https://api.poolstatis.test',
      projectName: 'Alpha',
      projectSlug: 'alpha',
      projectMode: 'product' as const,
      eventSeen: false,
      getSetupTask: vi.fn().mockResolvedValue(setupTask()),
      onCheck,
    };
    const view = render(<ProductConnectionGuide {...props} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Copy setup task' }));
    view.rerender(<ProductConnectionGuide {...props} checking />);
    const checkButton = await screen.findByRole('button', { name: 'Check now' });
    expect(checkButton).toBeEnabled();
    expect(screen.queryByText('Checking…')).not.toBeInTheDocument();
    expect(screen.queryByText(/No events yet/)).not.toBeInTheDocument();

    vi.useFakeTimers();
    try {
      fireEvent.click(checkButton);
      expect(onCheck).toHaveBeenCalledOnce();
      expect(screen.getByRole('button', { name: 'Checking…' })).toBeDisabled();

      await act(async () => { await vi.advanceTimersByTimeAsync(500); });
      expect(screen.getByRole('button', { name: 'Checking…' })).toBeDisabled();

      await act(async () => { await vi.advanceTimersByTimeAsync(500); });
      expect(screen.getByRole('button', { name: 'Check now' })).toBeEnabled();
      expect(screen.getByRole('status')).toHaveTextContent('No events yet');
      expect(screen.getByRole('status')).toHaveTextContent('Run the action above, then check again.');
    } finally {
      vi.useRealTimers();
    }
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
    expect(telemetryEvents('onboarding.key_copied')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'I saved it' }));
    expect(telemetryEvents('onboarding.key_copied')).toEqual([
      ['onboarding.key_copied', { environment: 'prod', method: 'manual' }, { distinctId: undefined }],
    ]);
    expect(await screen.findByRole('radio', { name: 'Codex' })).toBeChecked();
    await waitFor(() => expect(requestTask).toHaveBeenCalledOnce());

    view.rerender(<ProductConnectionGuide {...props} checking />);
    await waitFor(() => expect(requestTask).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: 'Copy setup task' }));
    expect((await screen.findAllByRole('alert')).at(-1)).toHaveTextContent('Select the content below');
    expect(screen.getByText(setupTask().task)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'I copied it' }));
    expect(await screen.findByText('Waiting for your first event…')).toBeInTheDocument();
    expect(telemetryEvents('onboarding.task_copied')).toEqual([
      ['onboarding.task_copied', { agent_id: 'codex', method: 'manual' }, { distinctId: undefined }],
    ]);
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

  it('uses the brand primary palette for the received-event success state', () => {
    const { container } = render(
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
        eventRegistered
        onCheck={vi.fn()}
        onOpenProject={vi.fn()}
      />,
    );

    const successPanel = screen.getByText('Event received').closest('section');
    const successIcon = container.querySelector('[data-slot="received-event-icon"]');

    expect(successPanel).toHaveClass('border-primary/50', 'bg-primary/10');
    expect(successPanel?.className).not.toContain('emerald');
    expect(successIcon).toHaveClass('bg-primary', 'text-primary-foreground');
  });
});

describe('condensed Setup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.sessionStorage.clear();
    window.localStorage.clear();
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
  });

  it('puts the real unfinished connection step first and opens it without an ambiguous continue action', async () => {
    const disconnectedProof = {
      complete: false,
      gates: [
        { key: 'data_source_connected', complete: false, required: true, evidence: {}, blocker: 'No key.', next_action: 'Create a key.' },
        { key: 'first_event_observed', complete: false, required: true, evidence: {}, blocker: 'No event.', next_action: 'Send one event.' },
      ],
      next_blocker: { key: 'data_source_connected', complete: false, required: true, evidence: {}, blocker: 'No key.', next_action: 'Create a key.' },
      final_result: null,
    };
    mockedStore.mockReturnValue({
      client: {
        onboardingStatus: vi.fn().mockResolvedValue(disconnectedProof),
        projectIntent: vi.fn().mockResolvedValue({
          intent: { project_mode: 'product', goal_ids: ['activation'], custom_goal: null },
        }),
      },
      baseUrl: 'https://api.poolstatis.test', token: 'sk_private', tokenKind: 'secret',
      projects: [{ slug: 'alpha', name: 'Alpha', timezone: 'UTC', active_metrics: 0, funnels: 0, events_30d: 0 }],
      project: 'alpha', env: 'prod',
    } as never);

    render(<MemoryRouter><Setup /></MemoryRouter>);

    const progress = await screen.findByRole('list', { name: 'Connection progress' });
    expect(screen.queryByRole('heading', { name: 'Create a product key' })).not.toBeInTheDocument();
    expect(document.querySelectorAll('button[data-variant="default"]:not(:disabled)')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Open connection' }));
    const keyStep = await screen.findByRole('heading', { name: 'Create a product key' });
    const status = screen.getByLabelText('Setup status');
    expect(screen.getByText('Next: Create and save a product key')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Continue setup' })).not.toBeInTheDocument();
    expect(document.querySelectorAll('button[data-variant="default"]:not(:disabled)')).toHaveLength(1);
    expect(progress.compareDocumentPosition(keyStep) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(keyStep.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('pauses first-event polling while the tab is hidden and resumes with an immediate read-back', async () => {
    vi.useFakeTimers();
    const onboardingStatus = vi.fn().mockResolvedValue(pendingProof);
    mockedStore.mockReturnValue({
      client: {
        onboardingStatus,
        projectIntent: vi.fn().mockResolvedValue({ intent: null }),
      },
      baseUrl: 'https://api.poolstatis.test', token: 'sk_private', tokenKind: 'secret',
      projects: [{ slug: 'alpha', name: 'Alpha', timezone: 'UTC', active_metrics: 0, funnels: 0, events_30d: 0 }],
      project: 'alpha', env: 'prod',
    } as never);
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);

    const view = render(<MemoryRouter><Setup /></MemoryRouter>);
    await act(async () => { await Promise.resolve(); });
    expect(onboardingStatus).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(10_000); });
    expect(onboardingStatus).toHaveBeenCalledTimes(1);

    hidden.mockReturnValue(false);
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); await Promise.resolve(); });
    expect(onboardingStatus).toHaveBeenCalledTimes(2);
    await act(async () => { vi.advanceTimersByTime(5_000); await Promise.resolve(); });
    expect(onboardingStatus).toHaveBeenCalledTimes(3);

    view.unmount();
    hidden.mockRestore();
    vi.useRealTimers();
  });

  it('resumes at the agent task when the server proves a product key exists', async () => {
    const requestTask = vi.fn().mockResolvedValue(setupTask());
    mockedStore.mockReturnValue({
      client: {
        onboardingStatus: vi.fn().mockResolvedValue(pendingProof),
        projectIntent: vi.fn().mockResolvedValue({
          intent: { project_mode: 'product', goal_ids: ['activation'], custom_goal: null },
        }),
        setupTask: requestTask,
      },
      baseUrl: 'https://api.poolstatis.test', token: 'sk_private', tokenKind: 'secret',
      projects: [{ slug: 'alpha', name: 'Alpha', timezone: 'UTC', active_metrics: 0, funnels: 0, events_30d: 0 }],
      project: 'alpha', env: 'prod',
    } as never);

    render(<MemoryRouter><Setup /></MemoryRouter>);

    fireEvent.click(await screen.findByRole('button', { name: 'Send first event' }));
    expect(await screen.findByText('Next: Copy one setup task to your agent')).toBeInTheDocument();
    expect(await screen.findByRole('radio', { name: 'Codex' })).toBeChecked();
    await waitFor(() => expect(requestTask).toHaveBeenCalledWith('alpha', {
      agent_id: 'codex', prefer_llm: false, env: 'prod',
    }));
  });

  it('uses the server next_blocker instead of inferring a blocker from local gates', async () => {
    const proof = {
      ...connectedProof,
      gates: connectedProof.gates.map((gate) => gate.key === 'data_source_connected'
        ? { ...gate, complete: false, blocker: 'No key.', next_action: 'Create a key.' }
        : gate),
      next_blocker: {
        key: 'metrics_activated',
        complete: false,
        required: true,
        evidence: {},
        blocker: 'No active metric has verified source evidence.',
        next_action: 'Review and activate a metric.',
      },
    };
    const client = {
      onboardingStatus: vi.fn().mockResolvedValue(proof),
      projectIntent: vi.fn().mockResolvedValue({
        intent: { project_mode: 'product', goal_ids: ['activation'], custom_goal: null },
      }),
    };
    const storeFor = (project: string) => ({
      client,
      baseUrl: 'https://api.poolstatis.test',
      token: 'sk_private',
      tokenKind: 'secret',
      projects: [
        { slug: 'alpha', name: 'Alpha', timezone: 'UTC', active_metrics: 0, funnels: 0, events_30d: 1 },
        { slug: 'beta', name: 'Beta', timezone: 'UTC', active_metrics: 0, funnels: 0, events_30d: 1 },
      ],
      project,
      env: 'prod',
    });
    mockedStore.mockReturnValue(storeFor('alpha') as never);

    const view = render(<MemoryRouter><Setup /></MemoryRouter>);

    expect(await screen.findByText('Review the registry')).toBeInTheDocument();
    expect(screen.getByText('No active metric has verified source evidence.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Review registry' })).toBeInTheDocument();
    expect(screen.queryByText('No product key yet')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy fix task' })).not.toBeInTheDocument();
    await waitFor(() => expect(telemetryEvents('onboarding.blocked')).toHaveLength(1));
    expect(telemetryEvents('onboarding.blocked')[0]?.[1]).toEqual({ blocker: 'metrics_activated' });
    view.rerender(<MemoryRouter><Setup /></MemoryRouter>);
    expect(telemetryEvents('onboarding.blocked')).toHaveLength(1);
    view.unmount();
    render(<MemoryRouter><Setup /></MemoryRouter>).unmount();
    expect(telemetryEvents('onboarding.blocked')).toHaveLength(1);
    mockedStore.mockReturnValue(storeFor('beta') as never);
    render(<MemoryRouter><Setup /></MemoryRouter>);
    await waitFor(() => expect(telemetryEvents('onboarding.blocked')).toHaveLength(2));
  });

  it('collapses completed connection into exact timestamped evidence and advances to registry review', async () => {
    const proof = {
      ...connectedProof,
      gates: [
        {
          key: 'data_source_connected', complete: true, required: true,
          evidence: { native: true, native_key_created_at: '2026-08-11T09:58:00.000Z' },
          blocker: null, next_action: null,
        },
        ...connectedProof.gates.filter((gate) => gate.key !== 'data_source_connected'),
        {
          key: 'metrics_activated', complete: false, required: true, evidence: {},
          blocker: 'No active metric has verified source evidence.', next_action: 'Review and activate a metric.',
        },
      ],
      next_blocker: {
        key: 'metrics_activated', complete: false, required: true, evidence: {},
        blocker: 'No active metric has verified source evidence.', next_action: 'Review and activate a metric.',
      },
    };
    mockedStore.mockReturnValue({
      client: {
        onboardingStatus: vi.fn().mockResolvedValue(proof),
        projectIntent: vi.fn().mockResolvedValue({ intent: { project_mode: 'product', goal_ids: ['activation'], custom_goal: null } }),
      },
      baseUrl: 'https://api.poolstatis.test', token: 'sk_private', tokenKind: 'secret',
      projects: [{ slug: 'alpha', name: 'Alpha', timezone: 'UTC', active_metrics: 0, funnels: 0, events_30d: 1 }],
      project: 'alpha', env: 'prod',
    } as never);

    render(<MemoryRouter><Setup /></MemoryRouter>);

    expect(await screen.findByText('Review the registry')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Review registry' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Create a product key' })).not.toBeInTheDocument();
    expect(screen.getByText(/Server read-back/)).toHaveTextContent(/ms/);
    const evidence = screen.getByRole('list', { name: 'Setup gate evidence' });
    expect(within(evidence).getByText('Data source connected')).toBeInTheDocument();
    expect(within(evidence).getByText('native_key_created_at')).toBeInTheDocument();
    expect(within(evidence).getByText('2026-08-11T09:58:00.000Z')).toBeInTheDocument();
    expect(within(evidence).getAllByText(/Evidence as of/).length).toBeGreaterThan(0);
  });

  it('keeps copied MCP config unverified until the server reports a real agent tool call', async () => {
    mockedStore.mockReturnValue({
      client: {
        onboardingStatus: vi.fn().mockResolvedValue(connectedProof),
        projectIntent: vi.fn().mockResolvedValue({ intent: null }),
      },
      baseUrl: 'https://api.poolstatis.test', token: 'pt_private_token', tokenKind: 'personal',
      projects: [{ slug: 'alpha', name: 'Alpha', timezone: 'UTC', active_metrics: 0, funnels: 0, events_30d: 1 }],
      project: 'alpha', env: 'prod',
    } as never);

    render(<MemoryRouter><Setup /></MemoryRouter>);

    const status = await screen.findByLabelText('Setup status');
    fireEvent.click(within(status).getByRole('button', { name: 'Connect' }));
    await act(async () => fireEvent.click(await screen.findByRole('button', { name: 'Copy config for Codex' })));

    expect(within(status).getByText('Agent access').parentElement).toHaveTextContent('Optional');
    expect(screen.getByText(/marks MCP connected only after that real tool call/)).toBeInTheDocument();
    expect(screen.queryByText('Agent access verified')).not.toBeInTheDocument();
  });

  it('shows the verified funnel or outcome read-back after the decision loop completes', async () => {
    const completed = {
      complete: true,
      gates: [
        ...connectedProof.gates,
        { key: 'metrics_activated', complete: true, required: true, evidence: { metric_key: 'activation_completed' }, blocker: null, next_action: null },
        { key: 'data_quality_accepted', complete: true, required: true, evidence: { issues: 0 }, blocker: null, next_action: null },
        { key: 'first_query_produced', complete: true, required: true, evidence: { query_run_id: 'query-1', source: 'native', created_at: '2026-08-11T10:00:00.000Z' }, blocker: null, next_action: null },
        { key: 'first_decision_saved', complete: true, required: true, evidence: { artifact_kind: 'saved_insight', insight_id: 'insight-1', created_at: '2026-08-11T10:02:00.000Z' }, blocker: null, next_action: null },
      ],
      next_blocker: null,
      final_result: {
        metric_key: 'activation_completed',
        metric_purpose: 'Measure completed activation after the setup funnel.',
        query_window: { from: '2026-08-04T00:00:00.000Z', to: '2026-08-11T00:00:00.000Z' },
        source: 'native',
        next_action: 'Keep the shorter setup and monitor the guardrail.',
      },
    };
    mockedStore.mockReturnValue({
      client: {
        onboardingStatus: vi.fn().mockResolvedValue(completed),
        projectIntent: vi.fn().mockResolvedValue({ intent: null }),
      },
      baseUrl: 'https://api.poolstatis.test', token: 'sk_private', tokenKind: 'secret',
      projects: [{ slug: 'alpha', name: 'Alpha', timezone: 'UTC', active_metrics: 1, funnels: 1, events_30d: 10 }],
      project: 'alpha', env: 'prod',
    } as never);

    render(<MemoryRouter><Setup /></MemoryRouter>);

    expect(await screen.findByText('Analysis loop is ready')).toBeInTheDocument();
    expect(screen.getByText(/protected human decision remains a separate Ship lifecycle step/)).toBeInTheDocument();
    expect(screen.getByText('First evidence-backed insight saved')).toBeInTheDocument();
    const result = await screen.findByRole('region', { name: 'Verified first outcome' });
    expect(result).toHaveTextContent('activation_completed');
    expect(result).toHaveTextContent('Measure completed activation after the setup funnel.');
    expect(result).toHaveTextContent('2026-08-04T00:00:00.000Z');
    expect(result).toHaveTextContent('Keep the shorter setup and monitor the guardrail.');
  });

  it('copies a server fix task and records only the normalized server gate key', async () => {
    const requestTask = vi.fn().mockResolvedValue(setupTask('codex', 'first_query_produced'));
    const feedback = vi.fn().mockResolvedValue({ recorded: true });
    mockedStore.mockReturnValue({
      client: {
        onboardingStatus: vi.fn().mockResolvedValue({
          ...connectedProof,
          next_blocker: {
            key: 'first_query_produced',
            complete: false,
            required: true,
            evidence: {},
            blocker: 'No answer has been produced yet.',
            next_action: 'Run the first trusted query.',
          },
        }),
        projectIntent: vi.fn().mockResolvedValue({
          intent: { project_mode: 'product', goal_ids: ['custom'], custom_goal: 'Understand successful workspace activation' },
        }),
        setupTask: requestTask,
        setupTaskFeedback: feedback,
      },
      baseUrl: 'https://api.poolstatis.test',
      token: 'sk_private',
      tokenKind: 'secret',
      projects: [{ slug: 'alpha', name: 'Alpha', timezone: 'UTC', active_metrics: 0, funnels: 0, events_30d: 1 }],
      project: 'alpha',
      env: 'prod',
    } as never);

    render(<MemoryRouter><Setup /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: 'Copy answer task' }));

    await waitFor(() => expect(requestTask).toHaveBeenCalledWith('alpha', {
      agent_id: 'codex',
      prefer_llm: false,
      kind: 'fix',
      env: 'prod',
    }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(setupTask('codex', 'first_query_produced').task));
    await waitFor(() => expect(feedback).toHaveBeenCalledWith('alpha', {
      outcome: 'blocked',
      blocker: 'first_query_produced',
    }));
    expect(Object.keys(feedback.mock.calls[0]![1])).toEqual(['outcome', 'blocker']);
    expect(telemetryEvents('onboarding.task_copied')).toEqual([
      ['onboarding.task_copied', { agent_id: 'codex', method: 'clipboard' }, { distinctId: undefined }],
    ]);
  });

  it('never renders or copies a credential-like server task', async () => {
    const feedback = vi.fn();
    mockedStore.mockReturnValue({
      client: {
        onboardingStatus: vi.fn().mockResolvedValue({
          ...connectedProof,
          next_blocker: {
            key: 'first_query_produced', complete: false, required: true, evidence: {},
            blocker: 'No answer yet.', next_action: 'Run a query.',
          },
        }),
        projectIntent: vi.fn().mockResolvedValue({
          intent: { project_mode: 'product', goal_ids: ['activation'], custom_goal: null },
        }),
        setupTask: vi.fn().mockResolvedValue({ ...setupTask('codex', 'first_query_produced'), task: 'Paste pk_live_secret_value into the agent chat.' }),
        setupTaskFeedback: feedback,
      },
      baseUrl: 'https://api.poolstatis.test', token: 'sk_private', tokenKind: 'secret',
      projects: [{ slug: 'alpha', name: 'Alpha', timezone: 'UTC', active_metrics: 0, funnels: 0, events_30d: 1 }],
      project: 'alpha', env: 'prod',
    } as never);

    render(<MemoryRouter><Setup /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: 'Copy answer task' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('credential-like text');
    expect(screen.queryByText(/pk_live_secret_value/)).not.toBeInTheDocument();
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    expect(feedback).not.toHaveBeenCalled();
  });

  it('offers a selectable fallback and records feedback only after manual confirmation', async () => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } });
    const feedback = vi.fn().mockResolvedValue({ recorded: true });
    mockedStore.mockReturnValue({
      client: {
        onboardingStatus: vi.fn().mockResolvedValue({
          ...connectedProof,
          next_blocker: {
            key: 'first_decision_saved', complete: false, required: true, evidence: {},
            blocker: 'No decision has been saved.', next_action: 'Save the first decision.',
          },
        }),
        projectIntent: vi.fn().mockResolvedValue({
          intent: { project_mode: 'product', goal_ids: ['activation'], custom_goal: null },
        }),
        setupTask: vi.fn().mockResolvedValue(setupTask('codex', 'first_decision_saved')),
        setupTaskFeedback: feedback,
      },
      baseUrl: 'https://api.poolstatis.test', token: 'sk_private', tokenKind: 'secret',
      projects: [{ slug: 'alpha', name: 'Alpha', timezone: 'UTC', active_metrics: 0, funnels: 0, events_30d: 1 }],
      project: 'alpha', env: 'prod',
    } as never);

    render(<MemoryRouter><Setup /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: 'Copy decision task' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Select the task below');
    expect(screen.getByText(setupTask().task)).toHaveAttribute('tabindex', '0');
    expect(feedback).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'I copied it' }));
    await waitFor(() => expect(feedback).toHaveBeenCalledWith('alpha', {
      outcome: 'blocked',
      blocker: 'first_decision_saved',
    }));
    expect(telemetryEvents('onboarding.task_copied')).toEqual([
      ['onboarding.task_copied', { agent_id: 'codex', method: 'manual' }, { distinctId: undefined }],
    ]);
  });

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
    expect(telemetryEvents('mcp.connect_started')).toHaveLength(1);
  });

  it('records MCP connected once only after both SDK proof and agent proof exist', async () => {
    let observation = 0;
    const onboardingStatus = vi.fn().mockImplementation(async () => {
      observation += 1;
      return {
        ...connectedProof,
        gates: connectedProof.gates.map((gate) => gate.key === 'agent_connected' ? {
          ...gate,
          complete: true,
          evidence: { observed_at: `2026-08-06T10:00:${String(observation).padStart(2, '0')}.000Z` },
        } : gate),
      };
    });
    const client = {
      onboardingStatus,
      projectIntent: vi.fn().mockResolvedValue({ intent: null }),
    };
    const storeFor = (project: string) => ({
      account: { organization: { name: 'Acme' }, user: { id: 'user-mcp' } },
      client,
      baseUrl: 'https://api.poolstatis.test', token: 'sk_private', tokenKind: 'secret',
      projects: [
        { slug: 'alpha', name: 'Alpha', timezone: 'UTC', active_metrics: 0, funnels: 0, events_30d: 1 },
        { slug: 'beta', name: 'Beta', timezone: 'UTC', active_metrics: 0, funnels: 0, events_30d: 1 },
      ],
      project, env: 'prod',
    });
    mockedStore.mockReturnValue(storeFor('alpha') as never);

    const view = render(<MemoryRouter><Setup /></MemoryRouter>);
    await waitFor(() => expect(telemetryEvents('mcp.connected')).toEqual([
      ['mcp.connected', {}, { distinctId: 'user-mcp' }],
    ]));
    view.rerender(<MemoryRouter><Setup /></MemoryRouter>);
    expect(telemetryEvents('mcp.connected')).toHaveLength(1);
    view.unmount();
    render(<MemoryRouter><Setup /></MemoryRouter>).unmount();
    expect(telemetryEvents('mcp.connected')).toHaveLength(1);
    expect(observation).toBeGreaterThan(1);
    const persistedDedupe = Array.from(
      { length: window.localStorage.length },
      (_, index) => window.localStorage.getItem(window.localStorage.key(index) ?? '') ?? '',
    ).join(' ');
    expect(persistedDedupe).not.toContain('alpha');
    expect(persistedDedupe).not.toContain('observed_at');
    expect(persistedDedupe).not.toContain('2026-08-06');
    mockedStore.mockReturnValue(storeFor('beta') as never);
    render(<MemoryRouter><Setup /></MemoryRouter>);
    await waitFor(() => expect(telemetryEvents('mcp.connected')).toHaveLength(2));
  });

  it('drops a stale fix-task response after the selected project unmounts it', async () => {
    let resolveAlpha!: (response: SetupTaskResponse) => void;
    const alphaResponse = new Promise<SetupTaskResponse>((resolve) => { resolveAlpha = resolve; });
    const requestTask = vi.fn((slug: string) => slug === 'alpha'
      ? alphaResponse
      : Promise.resolve(setupTask('codex', 'first_query_produced')));
    const feedback = vi.fn().mockResolvedValue({ recorded: true });
    const proof = {
      ...connectedProof,
      next_blocker: {
        key: 'first_query_produced', complete: false, required: true, evidence: {},
        blocker: 'No answer yet.', next_action: 'Run a query.',
      },
    };
    const client = {
      onboardingStatus: vi.fn().mockResolvedValue(proof),
      projectIntent: vi.fn().mockResolvedValue({
        intent: { project_mode: 'product', goal_ids: ['activation'], custom_goal: null },
      }),
      setupTask: requestTask,
      setupTaskFeedback: feedback,
    };
    const storeFor = (project: string) => ({
      client,
      baseUrl: 'https://api.poolstatis.test', token: 'sk_private', tokenKind: 'secret',
      projects: [
        { slug: 'alpha', name: 'Alpha', timezone: 'UTC', active_metrics: 0, funnels: 0, events_30d: 1 },
        { slug: 'beta', name: 'Beta', timezone: 'UTC', active_metrics: 0, funnels: 0, events_30d: 1 },
      ],
      project, env: 'prod',
    });
    mockedStore.mockReturnValue(storeFor('alpha') as never);
    const view = render(<MemoryRouter><Setup /></MemoryRouter>);

    fireEvent.click(await screen.findByRole('button', { name: 'Copy answer task' }));
    await waitFor(() => expect(requestTask).toHaveBeenCalledWith('alpha', expect.any(Object)));

    mockedStore.mockReturnValue(storeFor('beta') as never);
    view.rerender(<MemoryRouter><Setup /></MemoryRouter>);
    expect(await screen.findByText('Beta · prod')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Copy answer task' })).toBeInTheDocument();

    await act(async () => {
      resolveAlpha(setupTask('codex', 'first_query_produced'));
      await alphaResponse;
    });

    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    expect(feedback).not.toHaveBeenCalled();
    expect(telemetryEvents('onboarding.task_generated')).toHaveLength(0);
    expect(telemetryEvents('onboarding.task_copied')).toHaveLength(0);
    expect(screen.queryByText('Task copied')).not.toBeInTheDocument();
  });

  it('clears one-time key and error state when project or environment changes', async () => {
    const disconnectedProof = {
      complete: false,
      gates: [
        { key: 'data_source_connected', complete: false, required: true, evidence: {}, blocker: null, next_action: null },
        { key: 'first_event_observed', complete: false, required: true, evidence: {}, blocker: null, next_action: null },
      ],
      next_blocker: {
        key: 'data_source_connected', complete: false, required: true, evidence: {},
        blocker: 'No product key.', next_action: 'Create a product key.',
      },
      final_result: null,
    };
    const issueKey = vi.fn()
      .mockRejectedValueOnce(new Error('Alpha key failed'))
      .mockResolvedValueOnce({ token: 'pk_beta_once' });
    const client = {
      onboardingStatus: vi.fn().mockResolvedValue(disconnectedProof),
      projectIntent: vi.fn().mockResolvedValue({ intent: null }),
      issueKey,
    };
    const storeFor = (project: string, env = 'prod') => ({
      client,
      baseUrl: 'https://api.poolstatis.test', token: 'sk_private', tokenKind: 'secret',
      projects: [
        { slug: 'alpha', name: 'Alpha', timezone: 'UTC', active_metrics: 0, funnels: 0, events_30d: 0 },
        { slug: 'beta', name: 'Beta', timezone: 'UTC', active_metrics: 0, funnels: 0, events_30d: 0 },
      ],
      project, env,
    });
    mockedStore.mockReturnValue(storeFor('alpha') as never);
    const view = render(<MemoryRouter><Setup /></MemoryRouter>);

    fireEvent.click(await screen.findByRole('button', { name: 'Open connection' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Create product key' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Alpha key failed');

    mockedStore.mockReturnValue(storeFor('beta') as never);
    view.rerender(<MemoryRouter><Setup /></MemoryRouter>);
    expect(await screen.findByText('Beta · prod')).toBeInTheDocument();
    expect(screen.queryByText('Alpha key failed')).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Open connection' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Create product key' }));
    expect(await screen.findByRole('button', { name: 'Copy .env line' })).toBeInTheDocument();

    mockedStore.mockReturnValue(storeFor('alpha', 'dev') as never);
    view.rerender(<MemoryRouter><Setup /></MemoryRouter>);
    expect(await screen.findByText('Alpha · dev')).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Open connection' }));
    expect(await screen.findByRole('button', { name: 'Create product key' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy .env line' })).not.toBeInTheDocument();
  });

  it('remounts agent and task state for the selected project and environment', async () => {
    const requestTask = vi.fn().mockImplementation((_slug: string, body: { agent_id: string }) => Promise.resolve(setupTask(body.agent_id)));
    const client = {
      onboardingStatus: vi.fn().mockResolvedValue(pendingProof),
      projectIntent: vi.fn().mockResolvedValue({
        intent: { project_mode: 'product', goal_ids: ['activation'], custom_goal: null },
      }),
      setupTask: requestTask,
    };
    const storeFor = (project: string, env = 'prod') => ({
      client,
      baseUrl: 'https://api.poolstatis.test', token: 'sk_private', tokenKind: 'secret',
      projects: [
        { slug: 'alpha', name: 'Alpha', timezone: 'UTC', active_metrics: 0, funnels: 0, events_30d: 0 },
        { slug: 'beta', name: 'Beta', timezone: 'UTC', active_metrics: 0, funnels: 0, events_30d: 0 },
      ],
      project, env,
    });
    mockedStore.mockReturnValue(storeFor('alpha') as never);
    const view = render(<MemoryRouter><Setup /></MemoryRouter>);

    fireEvent.click(await screen.findByRole('button', { name: 'Send first event' }));
    expect(await screen.findByRole('radio', { name: 'Codex' })).toBeChecked();
    await waitFor(() => expect(requestTask).toHaveBeenCalledWith('alpha', { agent_id: 'codex', prefer_llm: false, env: 'prod' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Claude Code' }));
    await waitFor(() => expect(requestTask).toHaveBeenCalledWith('alpha', { agent_id: 'claude-code', prefer_llm: false, env: 'prod' }));

    mockedStore.mockReturnValue(storeFor('beta', 'dev') as never);
    view.rerender(<MemoryRouter><Setup /></MemoryRouter>);
    expect(await screen.findByText('Beta · dev')).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Send first event' }));
    expect(await screen.findByRole('radio', { name: 'Codex' })).toBeChecked();
    await waitFor(() => expect(requestTask).toHaveBeenCalledWith('beta', { agent_id: 'codex', prefer_llm: false, env: 'dev' }));
  });

  it('fully resets advanced webhook and danger-zone state when project or environment changes', async () => {
    const webhookDestinations = vi.fn().mockResolvedValue([]);
    const purgeData = vi.fn().mockResolvedValue({ events_deleted: 3, entities_deleted: 0 });
    const client = {
      onboardingStatus: vi.fn().mockResolvedValue(connectedProof),
      projectIntent: vi.fn().mockResolvedValue({ intent: null }),
      standard: vi.fn().mockResolvedValue('standard'),
      webhookDestinations,
      purgeData,
    };
    const storeFor = (project: string, env = 'prod') => ({
      client,
      baseUrl: 'https://api.poolstatis.test', token: 'sk_private', tokenKind: 'secret',
      projects: [
        { slug: 'alpha', name: 'Alpha', timezone: 'UTC', active_metrics: 0, funnels: 0, events_30d: 1 },
        { slug: 'beta', name: 'Beta', timezone: 'UTC', active_metrics: 0, funnels: 0, events_30d: 1 },
      ],
      project, env,
    });
    mockedStore.mockReturnValue(storeFor('alpha') as never);
    const view = render(<MemoryRouter><Setup /></MemoryRouter>);

    const rows = await screen.findByLabelText('Setup status');
    fireEvent.click(within(rows).getByRole('button', { name: 'Open' }));
    fireEvent.change(await screen.findByLabelText('Webhook URL'), { target: { value: 'https://hooks.alpha.test/private' } });
    fireEvent.change(screen.getByLabelText('Webhook authorization'), { target: { value: 'Bearer alpha-private' } });

    fireEvent.click(screen.getByRole('button', { name: 'Purge event data' }));
    fireEvent.change(await screen.findByPlaceholderText('alpha'), { target: { value: 'alpha' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Purge event data' }).at(-1)!);
    expect(await screen.findByText('Purged prod: 3 events, 0 entities removed.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Purge entities' }));
    fireEvent.change(await screen.findByPlaceholderText('alpha'), { target: { value: 'alpha' } });
    expect(screen.getByRole('heading', { name: 'Purge entities?' })).toBeInTheDocument();

    mockedStore.mockReturnValue(storeFor('beta', 'dev') as never);
    view.rerender(<MemoryRouter><Setup /></MemoryRouter>);
    expect(await screen.findByText('Beta · dev')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByLabelText('Advanced setup and administration')).not.toBeInTheDocument());
    expect(screen.queryByRole('heading', { name: 'Purge entities?' })).not.toBeInTheDocument();

    fireEvent.click(within(screen.getByLabelText('Setup status')).getByRole('button', { name: 'Open' }));
    expect(await screen.findByLabelText('Webhook URL')).toHaveValue('');
    expect(screen.getByLabelText('Webhook authorization')).toHaveValue('');
    expect(screen.queryByText('Purged prod: 3 events, 0 entities removed.')).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText('alpha')).not.toBeInTheDocument();
    await waitFor(() => expect(webhookDestinations).toHaveBeenCalledWith('beta'));
  });
});
