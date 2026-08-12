import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Projects } from './screens/Projects';
import { Profile } from './screens/Profile';
import { Usage } from './screens/Usage';
import { useStore } from './store';
import type { UsageControlResult } from './api/types';

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
const deleteProject = vi.fn();
const refreshProjects = vi.fn();
const setProject = vi.fn();

function renderProjects() {
  return render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><Projects /></MemoryRouter>);
}

function renderUsage() {
  return render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><Usage /></MemoryRouter>);
}

describe('cloud workspace project controls', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedStore.mockReturnValue({
      projects: [{ slug: 'alpha', name: 'Alpha', timezone: 'UTC', active_metrics: 0, funnels: 0, events_30d: 0 }],
      project: 'alpha',
      setProject,
      tokenKind: 'secret',
      client: { createProject, deleteProject },
      refreshProjects,
    } as never);
  });

  it('never offers organization project creation to a secret key session', () => {
    renderProjects();
    expect(screen.queryByRole('button', { name: 'New project' })).not.toBeInTheDocument();
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
      client: { createProject, deleteProject },
      refreshProjects,
      account: { membership: { role: 'owner' } },
    } as never);
    renderProjects();
    expect(screen.getByRole('button', { name: 'New project' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open Bravo' }));
    expect(setProject).toHaveBeenCalledWith('bravo');
  });

  it('creates a project, refreshes the list, and selects the created project', async () => {
    createProject.mockResolvedValue({ slug: 'new-project' });
    refreshProjects.mockResolvedValue(undefined);
    mockedStore.mockReturnValue({
      projects: [{ slug: 'alpha', name: 'Alpha', timezone: 'UTC', active_metrics: 0, funnels: 0, events_30d: 0 }],
      project: 'alpha', setProject, tokenKind: 'user', client: { createProject, deleteProject }, refreshProjects,
      account: { membership: { role: 'admin' } },
    } as never);
    renderProjects();
    fireEvent.click(screen.getByRole('button', { name: 'New project' }));
    fireEvent.change(screen.getByLabelText('Slug'), { target: { value: 'new-project' } });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'New project' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }));
    await waitFor(() => expect(createProject).toHaveBeenCalledWith({ slug: 'new-project', name: 'New project' }));
    await waitFor(() => expect(refreshProjects).toHaveBeenCalledOnce());
    expect(setProject).toHaveBeenCalledWith('new-project');
  });

  it('keeps the busy project-create control accessible', async () => {
    let resolveCreate: ((project: { slug: string }) => void) | undefined;
    createProject.mockReturnValue(new Promise((resolve) => { resolveCreate = resolve; }));
    mockedStore.mockReturnValue({
      projects: [{ slug: 'alpha', name: 'Alpha', timezone: 'UTC', active_metrics: 0, funnels: 0, events_30d: 0 }], project: 'alpha', setProject, tokenKind: 'user', client: { createProject, deleteProject }, refreshProjects,
      account: { membership: { role: 'owner' } },
    } as never);
    renderProjects();
    fireEvent.click(screen.getByRole('button', { name: 'New project' }));
    fireEvent.change(screen.getByLabelText('Slug'), { target: { value: 'new-project' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }));
    expect(screen.getByRole('button', { name: 'Creating…' })).toBeDisabled();
    resolveCreate?.({ slug: 'new-project' });
    await waitFor(() => expect(refreshProjects).toHaveBeenCalledOnce());
  });

  it('offers creation to an organization-wide personal token under the backend policy', () => {
    mockedStore.mockReturnValue({
      projects: [], project: null, setProject, tokenKind: 'personal', client: { createProject, deleteProject }, refreshProjects,
      account: null,
    } as never);
    renderProjects();
    expect(screen.getByRole('button', { name: 'New project' })).toBeInTheDocument();
  });

  it('keeps owner onboarding and project creation hidden for an empty hosted member workspace', () => {
    mockedStore.mockReturnValue({
      projects: [], project: null, setProject, tokenKind: 'user', client: { createProject, deleteProject }, refreshProjects,
      account: { membership: { role: 'member' } },
    } as never);
    renderProjects();
    expect(screen.queryByRole('button', { name: 'New project' })).not.toBeInTheDocument();
    expect(screen.getByText('No projects in this workspace')).toBeInTheDocument();
    expect(screen.queryByText('Create your workspace')).not.toBeInTheDocument();
  });

  it('starts first-project onboarding inside the existing owner organization', () => {
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

    expect(screen.getByText('What are you connecting?')).toBeInTheDocument();
    expect(screen.getByLabelText('Project name')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create workspace' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Workspace name')).not.toBeInTheDocument();
  });

  it('deletes a project only after typed confirmation and refreshes the workspace', async () => {
    deleteProject.mockResolvedValue({ deleted: true, slug: 'alpha' });
    refreshProjects.mockResolvedValue(undefined);
    mockedStore.mockReturnValue({
      projects: [{ slug: 'alpha', name: 'Alpha', timezone: 'UTC', active_metrics: 0, funnels: 0, events_30d: 0 }],
      project: 'alpha', setProject, tokenKind: 'user', client: { createProject, deleteProject }, refreshProjects,
      account: { membership: { role: 'owner' } },
    } as never);
    renderProjects();

    fireEvent.click(screen.getByRole('button', { name: 'Delete Alpha' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Delete Alpha?')).toBeInTheDocument();
    const confirm = within(dialog).getByPlaceholderText('alpha');
    fireEvent.change(confirm, { target: { value: 'alpha' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete project' }));

    await waitFor(() => expect(deleteProject).toHaveBeenCalledWith('alpha', 'alpha'));
    await waitFor(() => expect(refreshProjects).toHaveBeenCalledOnce());
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
  const usageControl = vi.fn();
  const usageActivity = vi.fn();
  const usageRange = vi.fn();

  function usageControlResult(overrides: Partial<UsageControlResult> = {}): UsageControlResult {
    const period = new Date().toISOString().slice(0, 7);
    return {
      schema_version: 1,
      request_id: 'usage-test-request',
      generated_at: `${period}-15T12:00:00.000Z`,
      scope: {
        organization_id: 'organization-1',
        window: { from: `${period}-01T00:00:00.000Z`, to: `${period}-28T23:59:59.999Z`, timezone: 'UTC' },
      },
      answer: {
        state: 'ready',
        headline: '1,200 accepted events this cycle',
        takeaway: 'Usage remains below the configured hard limit.',
        primary_value: { value: 1200, unit: 'count', formatted: '1,200' },
        why_it_matters: 'The workspace can keep ingesting without a limit breach.',
      },
      attention: [],
      evidence: {
        state: 'trusted',
        as_of: `${period}-15T12:00:00.000Z`,
        freshness: 'fresh',
        source_refs: [{ kind: 'usage_ledger', meter: 'events_stored' }],
        warnings: [],
        unavailable_reasons: [],
      },
      primary_action: { id: 'review-contributors', kind: 'navigate', label: 'Review contributors', href: '#usage-contributors-title' },
      secondary_actions: [],
      meter: 'events_stored',
      cycle: { from: `${period}-01T00:00:00.000Z`, to: `${period}-28T23:59:59.999Z`, timezone: 'UTC' },
      cap: { state: 'finite', value: 2000, remaining: 800, consequence_at_100_percent: 'A batch that would exceed the limit is rejected.' },
      pace: { observed_days: 7, events_per_day_7d: 40, projected_cycle_end: 1800, confidence: 'sufficient' },
      threshold_forecasts: [
        { percent: 50, state: 'reached', reached_or_projected_at: `${period}-12T00:00:00.000Z`, notification_state: 'not_configured', audit_source: 'usage_ledger' },
        { percent: 75, state: 'projected', reached_or_projected_at: `${period}-20T00:00:00.000Z`, notification_state: 'not_configured', audit_source: 'usage_ledger' },
        { percent: 90, state: 'projected', reached_or_projected_at: `${period}-26T00:00:00.000Z`, notification_state: 'not_configured', audit_source: 'usage_ledger' },
        { percent: 100, state: 'not_projected', reached_or_projected_at: null, notification_state: 'not_configured', audit_source: 'usage_ledger' },
      ],
      contributors: [{
        project_slug: 'alpha', project_name: 'Alpha', environment: 'prod',
        accepted_events: 1200, share: 1, change_7d: 0.1, last_ingest_at: `${period}-15T11:55:00.000Z`,
      }],
      reconciliation: {
        metered_quantity: 1200,
        attributed_quantity: 1200,
        difference: 0,
        unattributed_quantity: 0,
        overattributed_quantity: 0,
        state: 'reconciled',
      },
      ...overrides,
    };
  }

  function usageStore() {
    return {
      tokenKind: 'user',
      account: { membership: { role: 'owner' } },
      client: { usageControl, usageActivity, usageRange },
    } as never;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    usageControl.mockResolvedValue(usageControlResult());
    usageActivity.mockResolvedValue({
      meter: 'events_stored', date_from: '2026-07-01', date_to: '2026-07-30', quantity: '42',
      source: 'usage_ledger', timezone: 'UTC', projects: [],
    });
    const month = new Date().toISOString().slice(0, 7);
    usageRange.mockResolvedValue({
      meter: 'events_stored', from: month, to: month, timezone: 'UTC', granularity: 'month',
      usage_basis: 'ingest_time', quantity: '0', periods: [{
        period: month, quantity: '0', unattributed_quantity: '0', warnings: [], projects: [],
      }],
      current_entitlement: {
        period: month, hard_limit: null, warning_thresholds: [], basis: 'current_configuration',
      },
    });
  });

  it('separates accepted-event activity ranges from the monthly quota ledger', async () => {
    mockedStore.mockReturnValue(usageStore());
    renderUsage();

    fireEvent.click(screen.getByText('Historical ledger and custom ranges'));
    expect(await screen.findByRole('heading', { name: 'Accepted-event activity' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Last 7 days' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Last 30 days' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText('Activity from')).toHaveAttribute('type', 'date');
    expect(screen.getByLabelText('Activity to')).toHaveAttribute('type', 'date');
    await waitFor(() => expect(usageActivity).toHaveBeenCalledOnce());

    fireEvent.click(screen.getByRole('button', { name: 'Last 7 days' }));
    await waitFor(() => expect(usageActivity).toHaveBeenCalledTimes(2));
    const [from, to] = usageActivity.mock.calls[1] as [string, string];
    expect(Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)).toBe(6 * 24 * 60 * 60 * 1000);
    expect(screen.getByRole('heading', { name: 'Monthly usage history' })).toBeInTheDocument();
  });

  it('validates custom activity dates before making another request', async () => {
    mockedStore.mockReturnValue(usageStore());
    renderUsage();
    fireEvent.click(screen.getByText('Historical ledger and custom ranges'));
    await waitFor(() => expect(usageActivity).toHaveBeenCalledOnce());

    fireEvent.change(screen.getByLabelText('Activity from'), { target: { value: '' } });
    expect(await screen.findByText('Choose both dates in YYYY-MM-DD format.')).toBeInTheDocument();
    expect(usageActivity).toHaveBeenCalledOnce();
  });

  it('uses a strict UTC calendar month and renders the events_stored ledger with a mobile-safe breakdown', async () => {
    const expectedMonth = new Date().toISOString().slice(0, 7);
    mockedStore.mockReturnValue(usageStore());
    renderUsage();
    await waitFor(() => expect(usageControl).toHaveBeenCalledWith(expectedMonth));
    expect(screen.getByText(`${expectedMonth} UTC`)).toBeInTheDocument();
    expect(screen.getByTestId('usage-current-quantity')).toHaveTextContent('1,200');
    expect(screen.getByText('accepted events')).toBeInTheDocument();
    expect(screen.getByText('Threshold rules').closest('details')).not.toHaveAttribute('open');
    expect(screen.getByText(/^Reached /)).toBeInTheDocument();
    expect(screen.getAllByText(/^Projected /)).not.toHaveLength(0);
    expect(screen.getByTestId('usage-breakdown-scroll')).toHaveClass('overflow-x-auto');
    expect(screen.getByRole('img', { name: '60 percent of the configured hard limit used' })).toBeInTheDocument();
    expect(screen.queryByText(/MTU|price|seat/i)).not.toBeInTheDocument();
  });

  it('states loading, error, and empty usage states without implying product analytics', async () => {
    let resolveUsage: ((value: unknown) => void) | undefined;
    usageControl.mockReturnValue(new Promise((resolve) => { resolveUsage = resolve; }));
    mockedStore.mockReturnValue(usageStore());
    const view = renderUsage();
    expect(screen.getByText('Loading usage ledger…')).toBeInTheDocument();
    resolveUsage?.(usageControlResult({
      answer: {
        state: 'empty', headline: 'No stored events this cycle', takeaway: 'No accepted events were stored.',
        primary_value: { value: 0, unit: 'count', formatted: '0' }, why_it_matters: 'There is no current-cycle usage to review.',
      },
      cap: { state: 'not_configured', value: null, remaining: null, consequence_at_100_percent: null },
      contributors: [],
      reconciliation: {
        metered_quantity: 0, attributed_quantity: 0, difference: 0,
        unattributed_quantity: 0, overattributed_quantity: 0, state: 'reconciled',
      },
      threshold_forecasts: [50, 75, 90, 100].map((percent) => ({
        percent: percent as 50 | 75 | 90 | 100, state: 'not_applicable' as const, reached_or_projected_at: null,
        notification_state: 'not_configured' as const, audit_source: 'usage_ledger' as const,
      })),
    }));
    await screen.findByText(/No stored events in/);
    expect(screen.getByText('No events')).toBeInTheDocument();
    expect(screen.getByText('Nothing to reconcile')).toBeInTheDocument();
    view.unmount();

    usageControl.mockRejectedValue(new Error('usage read failed'));
    renderUsage();
    await screen.findByText(/usage read failed/);
  });

  it('renders a zero hard cap without invalid ledger geometry and calls the cap reached', async () => {
    usageControl.mockResolvedValue(usageControlResult({
      answer: {
        state: 'ready', headline: 'No events can be accepted', takeaway: 'The configured hard limit is zero.',
        primary_value: { value: 0, unit: 'count', formatted: '0' }, why_it_matters: 'Every non-empty batch would exceed the hard limit.',
      },
      cap: { state: 'finite', value: 0, remaining: 0, consequence_at_100_percent: 'At 0 events, a batch that would exceed the limit is rejected.' },
      contributors: [],
    }));
    mockedStore.mockReturnValue(usageStore());
    renderUsage();
    await screen.findByText('Hard limit reached');
    const meter = screen.getByRole('img', { name: '0 percent of the configured hard limit used' });
    expect(meter.innerHTML).not.toContain('NaN');
    expect(screen.getAllByText('At 0 events, a batch that would exceed the limit is rejected.')).toHaveLength(2);
  });
});
