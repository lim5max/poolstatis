import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Projects } from './screens/Projects';
import { Profile } from './screens/Profile';
import { Usage } from './screens/Usage';
import { Onboarding } from './screens/Onboarding';
import { useStore } from './store';

vi.mock('./store', async (importOriginal) => ({ ...(await importOriginal<typeof import('./store')>()), useStore: vi.fn() }));
const { logout, hostedAuth } = vi.hoisted(() => {
  const logout = vi.fn();
  return { logout, hostedAuth: vi.fn(() => ({ logout })) };
});
vi.mock('./oidc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./oidc')>()),
  useHostedAuth: hostedAuth,
}));

const mockedStore = vi.mocked(useStore);
const createProject = vi.fn();
const refreshProjects = vi.fn();
const setProject = vi.fn();

function renderProjects() {
  return render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><Projects /></MemoryRouter>);
}

describe('cloud workspace project controls', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedStore.mockReturnValue({
      projects: [{ slug: 'alpha', name: 'Alpha', timezone: 'UTC', active_metrics: 0, funnels: 0, events_30d: 0 }],
      project: 'alpha',
      setProject,
      tokenKind: 'secret',
      client: { createProject },
      refreshProjects,
    } as never);
  });

  it('never offers organization project creation to a secret key session', () => {
    renderProjects();
    expect(screen.queryByRole('button', { name: 'Create' })).not.toBeInTheDocument();
  });

  it('offers project creation to a hosted owner and switches the selected project', () => {
    mockedStore.mockReturnValue({
      projects: [
        { slug: 'alpha', name: 'Alpha', timezone: 'UTC', active_metrics: 0, funnels: 0, events_30d: 0 },
        { slug: 'bravo', name: 'Bravo', timezone: 'UTC', active_metrics: 0, funnels: 0, events_30d: 0 },
      ],
      project: 'alpha',
      setProject,
      tokenKind: 'user',
      client: { createProject },
      refreshProjects,
      account: { membership: { role: 'owner' } },
    } as never);
    renderProjects();
    expect(screen.getByRole('button', { name: 'Create' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open Bravo' }));
    expect(setProject).toHaveBeenCalledWith('bravo');
  });

  it('creates a project, refreshes the list, and selects the created project', async () => {
    createProject.mockResolvedValue({ slug: 'new-project' });
    refreshProjects.mockResolvedValue(undefined);
    mockedStore.mockReturnValue({
      projects: [{ slug: 'alpha', name: 'Alpha', timezone: 'UTC', active_metrics: 0, funnels: 0, events_30d: 0 }],
      project: 'alpha', setProject, tokenKind: 'user', client: { createProject }, refreshProjects,
      account: { membership: { role: 'admin' } },
    } as never);
    renderProjects();
    fireEvent.change(screen.getByLabelText('Slug'), { target: { value: 'new-project' } });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'New project' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(createProject).toHaveBeenCalledWith({ slug: 'new-project', name: 'New project' }));
    await waitFor(() => expect(refreshProjects).toHaveBeenCalledOnce());
    expect(setProject).toHaveBeenCalledWith('new-project');
  });

  it('keeps the busy project-create control accessible', async () => {
    let resolveCreate: ((project: { slug: string }) => void) | undefined;
    createProject.mockReturnValue(new Promise((resolve) => { resolveCreate = resolve; }));
    mockedStore.mockReturnValue({
      projects: [{ slug: 'alpha', name: 'Alpha', timezone: 'UTC', active_metrics: 0, funnels: 0, events_30d: 0 }], project: 'alpha', setProject, tokenKind: 'user', client: { createProject }, refreshProjects,
      account: { membership: { role: 'owner' } },
    } as never);
    renderProjects();
    fireEvent.change(screen.getByLabelText('Slug'), { target: { value: 'new-project' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(screen.getByRole('button', { name: 'Creating…' })).toBeDisabled();
    resolveCreate?.({ slug: 'new-project' });
    await waitFor(() => expect(refreshProjects).toHaveBeenCalledOnce());
  });

  it('offers creation to an organization-wide personal token under the backend policy', () => {
    mockedStore.mockReturnValue({
      projects: [], project: null, setProject, tokenKind: 'personal', client: { createProject }, refreshProjects,
      account: null,
    } as never);
    renderProjects();
    expect(screen.getByRole('button', { name: 'Create' })).toBeInTheDocument();
  });

  it('keeps owner onboarding and project creation hidden for an empty hosted member workspace', () => {
    mockedStore.mockReturnValue({
      projects: [], project: null, setProject, tokenKind: 'user', client: { createProject }, refreshProjects,
      account: { membership: { role: 'member' } },
    } as never);
    renderProjects();
    expect(screen.queryByRole('button', { name: 'Create' })).not.toBeInTheDocument();
    expect(screen.getByText('No projects in this workspace')).toBeInTheDocument();
    expect(screen.queryByText('Create your workspace')).not.toBeInTheDocument();
  });

  it('creates the first project inside an existing owner organization without offering a new workspace', () => {
    mockedStore.mockReturnValue({
      projects: [], project: null, setProject, tokenKind: 'user', client: {
        completeOnboarding: vi.fn(),
      }, refreshProjects,
      account: {
        organization: { id: 'org-existing', name: 'Existing owner organization' },
        membership: { organization_id: 'org-existing', role: 'owner' },
      },
    } as never);
    renderProjects();

    expect(screen.getByText('What do you want to learn?')).toBeInTheDocument();
    expect(screen.getByText('Step 1 of 3')).toBeInTheDocument();
    expect(screen.queryByLabelText('Project name')).not.toBeInTheDocument();
    expect(screen.queryByText('What this creates')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create workspace' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Workspace name')).not.toBeInTheDocument();
  });
});

describe('hosted intent onboarding', () => {
  it('keeps project creation backwards compatible and generates a secret-free request', async () => {
    const completeOnboarding = vi.fn().mockResolvedValue({
      organization: { id: 'org-1', name: 'Acme' },
      project: { slug: 'my-product', name: 'My product', timezone: 'UTC' },
      tokens: { personal: 'pt_onetime_secret', ingest_prod: 'pk_onetime_secret' },
      mcp: {
        command: 'pnpm',
        args: ['--silent', 'dlx', '@poolstatis/mcp@0.5.0'],
        package_status: 'published',
        note: 'Registry package verified.',
        env: { POOLSTATIS_URL: 'https://api.poolstatis.test', POOLSTATIS_TOKEN: 'pt_onetime_secret' },
      },
    });
    mockedStore.mockReturnValue({
      account: { organization: { name: 'Acme' } },
      client: { completeOnboarding },
      refreshProjects: vi.fn(),
      setProject: vi.fn(),
    } as never);

    render(<MemoryRouter><Onboarding /></MemoryRouter>);
    fireEvent.change(screen.getByLabelText('Ask your own question'), {
      target: { value: 'Did the latest release help more teams publish successfully?' },
    });
    expect(screen.getByText('Suggested: Measure a release')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(screen.getByText('Step 2 of 3')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Name your product' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Understand activation/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }));

    await waitFor(() => expect(completeOnboarding).toHaveBeenCalledWith({
      workspace_name: 'Acme',
      project_name: 'My product',
      project_slug: 'my-product',
    }));
    const request = await screen.findByTestId('hosted-agent-request');
    expect(screen.getByText('Step 3 of 3')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Give this to your agent' })).toBeInTheDocument();
    expect(within(request).getByText(/project "my-product" in environment "prod"/)).toBeInTheDocument();
    expect(request).toHaveTextContent('Product question: Did the latest release help more teams publish successfully?');
    expect(request).not.toHaveTextContent('pt_onetime_secret');
    expect(request).not.toHaveTextContent('pk_onetime_secret');
    expect(screen.getByText('pt_onetime_secret')).toBeInTheDocument();
  });
});

describe('hosted profile and personal token lifecycle', () => {
  const personalTokens = vi.fn();
  const issuePersonalToken = vi.fn();
  const revokePersonalToken = vi.fn();
  const updateProfile = vi.fn();
  const disconnect = vi.fn();
  const refreshAccount = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    hostedAuth.mockImplementation(() => ({ logout }));
    localStorage.clear();
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
    personalTokens.mockResolvedValue([{ id: 'token-1', label: 'CLI', token: 'pt_...cafe', created_at: '2026-07-01T00:00:00.000Z', last_used_at: null, revoked_at: null }]);
    issuePersonalToken.mockResolvedValue({ id: 'token-2', token: 'pt_plaintext_only_once' });
    revokePersonalToken.mockResolvedValue({ revoked: true });
    updateProfile.mockResolvedValue({});
    mockedStore.mockReturnValue({
      tokenKind: 'user', disconnect, refreshAccount,
      account: {
        user: { email: 'owner@example.test', email_verified: true, display_name: 'Mira', picture_url: null },
        membership: { role: 'owner' }, organization: { name: 'Acme' },
      },
      client: { personalTokens, issuePersonalToken, revokePersonalToken, updateProfile },
    } as never);
  });

  it('edits the local profile, exposes verified identity and logs out', async () => {
    render(<Profile />);
    expect(screen.getByText('Verified email')).toBeInTheDocument();
    expect(screen.getByText('owner@example.test')).toBeInTheDocument();
    expect(screen.getByText('owner')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Mira Chen' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));
    await waitFor(() => expect(updateProfile).toHaveBeenCalledWith({ display_name: 'Mira Chen' }));
    fireEvent.click(screen.getByRole('button', { name: 'Log out' }));
    expect(disconnect).toHaveBeenCalledOnce();
    expect(logout).toHaveBeenCalledOnce();
    expect(screen.getByTestId('personal-tokens-scroll')).toHaveClass('overflow-x-auto');
  });

  it('does not initialize hosted identity actions for secret or personal self-host profile visits', () => {
    hostedAuth.mockImplementation(() => { throw new Error('OIDC provider is absent'); });
    mockedStore.mockReturnValue({ tokenKind: 'secret' } as never);
    const secret = render(<Profile />);
    expect(screen.getByText('Hosted profile unavailable')).toBeInTheDocument();
    secret.unmount();
    mockedStore.mockReturnValue({ tokenKind: 'personal' } as never);
    render(<Profile />);
    expect(screen.getByText('Hosted profile unavailable')).toBeInTheDocument();
    expect(hostedAuth).not.toHaveBeenCalled();
  });

  it('keeps a hosted member able to list and revoke own masked tokens without token issuance', async () => {
    mockedStore.mockReturnValue({
      tokenKind: 'user', disconnect, refreshAccount,
      account: { user: { email: 'member@example.test', email_verified: true, display_name: 'Member', picture_url: null }, membership: { role: 'member' }, organization: { name: 'Acme' } },
      client: { personalTokens, issuePersonalToken, revokePersonalToken, updateProfile },
    } as never);
    render(<Profile />);
    await screen.findByText('pt_...cafe');
    expect(screen.queryByRole('button', { name: 'Create personal token' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Revoke CLI' })).toBeInTheDocument();
  });

  it('reveals a personal token only in the creation dialog, then retains only its masked audit row', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    render(<Profile />);
    await screen.findByText('pt_...cafe');
    fireEvent.click(screen.getByRole('button', { name: 'Create personal token' }));
    await screen.findByRole('dialog');
    expect(screen.getByText('pt_plaintext_only_once')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Copy token' }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith('pt_plaintext_only_once'));
    fireEvent.click(screen.getByRole('button', { name: 'I copied the token' }));
    expect(screen.queryByText('pt_plaintext_only_once')).not.toBeInTheDocument();
    expect(setItem.mock.calls.every(([, value]) => !String(value).includes('pt_plaintext_only_once'))).toBe(true);
    setItem.mockRestore();
    expect(screen.getByText('pt_...cafe')).toBeInTheDocument();
  });

  it('revokes a masked personal token and keeps the audit trail visible', async () => {
    personalTokens.mockResolvedValueOnce([{ id: 'token-1', label: 'CLI', token: 'pt_...cafe', created_at: '2026-07-01T00:00:00.000Z', last_used_at: null, revoked_at: null }])
      .mockResolvedValueOnce([{ id: 'token-1', label: 'CLI', token: 'pt_...cafe', created_at: '2026-07-01T00:00:00.000Z', last_used_at: null, revoked_at: '2026-07-02T00:00:00.000Z' }]);
    render(<Profile />);
    await screen.findByText('pt_...cafe');
    fireEvent.click(screen.getByRole('button', { name: 'Revoke CLI' }));
    fireEvent.click(screen.getByRole('button', { name: 'Revoke token' }));
    await waitFor(() => expect(revokePersonalToken).toHaveBeenCalledWith('token-1'));
    await screen.findByText('Revoked');
  });

  it('keeps the revoke dialog open and explains a revocation failure', async () => {
    revokePersonalToken.mockRejectedValue(new Error('token revocation failed'));
    render(<Profile />);
    await screen.findByText('pt_...cafe');
    fireEvent.click(screen.getByRole('button', { name: 'Revoke CLI' }));
    fireEvent.click(screen.getByRole('button', { name: 'Revoke token' }));
    await screen.findByText(/token revocation failed/);
    expect(screen.getByRole('dialog')).toHaveTextContent('token revocation failed');
  });
});

describe('organization usage ledger', () => {
  const usage = vi.fn();

  function usageStore() {
    return {
      tokenKind: 'user',
      account: { membership: { role: 'owner' } },
      client: { usage },
    } as never;
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses a strict UTC calendar month and renders the events_stored ledger with a mobile-safe breakdown', async () => {
    usage.mockResolvedValue({
      meter: 'events_stored', period: '2026-07', quantity: 1200, hard_limit: 2000,
      warning_thresholds: [1000, 1800], warnings: [{ threshold: 1000, quantity: 1200 }],
      projects: [{ id: 'project-1', slug: 'alpha', name: 'Alpha', quantity: 1200, environments: [{ env: 'prod', quantity: 1100 }, { env: 'staging', quantity: 100 }] }],
    });
    mockedStore.mockReturnValue(usageStore());
    render(<Usage />);
    const expectedMonth = new Date().toISOString().slice(0, 7);
    await waitFor(() => expect(usage).toHaveBeenCalledWith(expectedMonth));
    expect(screen.getByLabelText('UTC month')).toHaveValue(expectedMonth);
    expect(screen.getByText('events_stored')).toBeInTheDocument();
    expect(screen.getByText(/Warning threshold reached: 1,000 events\./)).toBeInTheDocument();
    expect(screen.getByTestId('usage-ledger-rail')).toBeInTheDocument();
    expect(screen.getByTestId('usage-breakdown-scroll')).toHaveClass('overflow-x-auto');
    expect(screen.queryByText(/MTU|price|seat/i)).not.toBeInTheDocument();
  });

  it('states loading, error, and empty usage states without implying product analytics', async () => {
    let resolveUsage: ((value: unknown) => void) | undefined;
    usage.mockReturnValue(new Promise((resolve) => { resolveUsage = resolve; }));
    mockedStore.mockReturnValue(usageStore());
    const view = render(<Usage />);
    expect(screen.getByText('Loading usage ledger…')).toBeInTheDocument();
    resolveUsage?.({ meter: 'events_stored', period: '2026-07', quantity: 0, hard_limit: null, warning_thresholds: [], warnings: [], projects: [] });
    await screen.findByText(/No stored events in/);
    view.unmount();

    usage.mockRejectedValue(new Error('usage read failed'));
    render(<Usage />);
    await screen.findByText(/usage read failed/);
  });

  it('renders a zero hard cap without invalid ledger geometry and calls the cap reached', async () => {
    usage.mockResolvedValue({ meter: 'events_stored', period: '2026-07', quantity: 0, hard_limit: 0, warning_thresholds: [], warnings: [], projects: [] });
    mockedStore.mockReturnValue(usageStore());
    render(<Usage />);
    await screen.findByText('Hard limit reached — 0 event limit');
    expect(screen.getByTestId('usage-ledger-rail').innerHTML).not.toContain('NaN');
    expect(screen.getByLabelText('Hard limit 0')).toHaveStyle({ left: '0%' });
  });
});
