import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from './components/ui/tooltip';
import { Profile } from './screens/Profile';
import { Projects } from './screens/Projects';
import { Registry } from './screens/Registry';
import { useStore } from './store';

vi.mock('./store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./store')>()),
  useStore: vi.fn(),
}));
vi.mock('./oidc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./oidc')>()),
  useHostedAuth: vi.fn(() => ({ logout: vi.fn() })),
}));

const mockedStore = vi.mocked(useStore);

const metric = {
  id: 'metric-1',
  key: 'activated_users',
  name: 'Activated users',
  purpose: 'Count users who receive meaningful product value.',
  category: 'activation',
  tags: [],
  type: 'unique_actors',
  source: { event: 'onboarding.completed' },
  status: 'active',
  owner: null,
  deprecation_reason: null,
  deprecated_at: null,
} as const;

const currentDefinition = {
  revision: 2,
  fingerprint: 'a'.repeat(64),
  aggregation: 'unique_actors',
  definition: {
    key: metric.key,
    purpose: metric.purpose,
    type: metric.type,
    aggregation: 'unique_actors',
    source: metric.source,
  },
};

const emptyImpact = {
  severity: 'low' as const,
  summary: { answers: 0, funnels: 0, measurement_contracts: 0, releases: 0, experiments: 0 },
  references: [],
  truncated: false,
};

describe('semantic control surfaces', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows a server-derived self-host account mode with one local next action', async () => {
    const accountMode = vi.fn().mockResolvedValue({
      schema_version: 1,
      deployment: { mode: 'self_host', hosted_account: 'not_configured' },
      session: { kind: 'secret', scope: 'project', role: null },
      capabilities: {
        portfolio: 'project_only', compare_projects: false,
        manage_profile: false, manage_personal_tokens: false,
      },
      primary_action: { id: 'open_local_setup', kind: 'navigate', label: 'Open local setup', href: '/setup' },
    });
    mockedStore.mockReturnValue({ tokenKind: 'secret', client: { accountMode } } as never);

    render(<MemoryRouter><Profile /></MemoryRouter>);

    expect(await screen.findByText('Self-hosted Core')).toBeInTheDocument();
    expect(screen.getByText('Project-scoped key')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open local setup' })).toHaveAttribute('href', '/setup');
    expect(accountMode).toHaveBeenCalledOnce();
  });

  it('reports incompatible cross-project semantics without rendering metric values', async () => {
    const compareProjects = vi.fn().mockResolvedValue({
      schema_version: 1,
      state: 'unavailable',
      generated_at: '2026-08-11T10:00:00.000Z',
      metric: {
        key: metric.key,
        purpose: metric.purpose,
        type: metric.type,
        aggregation: 'unique_actors',
        fingerprint: currentDefinition.fingerprint,
      },
      scope: {
        environment: 'prod',
        window: { from: '2026-07-12T10:00:00.000Z', to: '2026-08-11T10:00:00.000Z', timezone: 'UTC' },
      },
      projects: [
        { slug: 'alpha', name: 'Alpha', fingerprint: currentDefinition.fingerprint },
        { slug: 'bravo', name: 'Bravo', fingerprint: 'b'.repeat(64) },
      ],
      incompatibilities: [{
        project_slug: 'bravo', code: 'purpose_mismatch',
        message: 'Metric purpose differs from the first selected project.',
      }],
      primary_action: {
        id: 'review_metric_definitions', kind: 'navigate',
        label: 'Review metric definitions', href: '/registry',
      },
    });
    mockedStore.mockReturnValue({
      projects: [
        { slug: 'alpha', name: 'Alpha', timezone: 'UTC', active_metrics: 1, funnels: 0, events_30d: 100 },
        { slug: 'bravo', name: 'Bravo', timezone: 'UTC', active_metrics: 1, funnels: 0, events_30d: 80 },
      ],
      project: 'alpha', setProject: vi.fn(), tokenKind: 'personal', projectScope: 'org',
      account: null, client: { compareProjects }, refreshProjects: vi.fn(), env: 'prod',
    } as never);

    render(<MemoryRouter><Projects /></MemoryRouter>);
    fireEvent.change(screen.getByLabelText('Metric key'), { target: { value: metric.key } });
    fireEvent.click(screen.getByRole('button', { name: 'Compare projects' }));

    expect(await screen.findByText('Comparison unavailable')).toBeInTheDocument();
    expect(screen.getByText(/purpose differs/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Review metric definitions' })).toHaveAttribute('href', '/registry');
    expect(screen.queryByRole('columnheader', { name: 'Value' })).not.toBeInTheDocument();
    expect(compareProjects).toHaveBeenCalledWith(expect.objectContaining({
      metric_key: metric.key,
      projects: ['alpha', 'bravo'],
      environment: 'prod',
    }));
  });

  it('previews dependency impact before a confirmed immutable metric revision', async () => {
    const metricDefinition = vi.fn().mockResolvedValue({
      schema_version: 1,
      metric: { key: metric.key, name: metric.name, type: metric.type, status: metric.status },
      current: currentDefinition,
      revisions: [{
        id: 'revision-2', ...currentDefinition, action: 'created', actor: 'agent:test',
        created_at: '2026-08-11T09:00:00.000Z',
      }],
      impact: emptyImpact,
      primary_action: { id: 'preview_metric_definition', kind: 'navigate', label: 'Review a semantic change', href: '/registry' },
    });
    const previewMetricDefinition = vi.fn().mockResolvedValue({
      schema_version: 1,
      state: 'ready',
      metric: { key: metric.key, name: metric.name, type: metric.type, status: metric.status },
      expected_revision: 2,
      current: currentDefinition,
      proposed: {
        fingerprint: 'b'.repeat(64),
        aggregation: 'unique_actors',
        definition: {
          ...currentDefinition.definition,
          purpose: 'Count users after their first completed onboarding milestone.',
        },
      },
      changed_fields: ['purpose'],
      impact: {
        severity: 'medium',
        summary: { ...emptyImpact.summary, funnels: 1 },
        references: [{ kind: 'funnel', ref: 'activation', label: 'Activation', status: null }],
        truncated: false,
      },
      requires_confirmation: true,
      primary_action: {
        id: 'apply_metric_definition', kind: 'open_confirmation',
        label: 'Apply revision 3', impact: 'Creates one immutable semantic revision and affects 1 registered dependency.',
      },
    });
    const applyMetricDefinition = vi.fn().mockResolvedValue({
      applied: true, previous_revision: 2, revision: 3,
      current: { ...currentDefinition, revision: 3, fingerprint: 'b'.repeat(64) },
      impact: emptyImpact,
    });
    mockedStore.mockReturnValue({
      client: {
        schema: vi.fn().mockResolvedValue({
          project: { slug: 'alpha', name: 'Alpha' }, env: 'prod', metrics: [metric],
          metric_categories: [], funnels: [], entity_types: [], observed_events_30d: [],
          properties: [], identity: {}, sources: [],
        }),
        metricDefinition, previewMetricDefinition, applyMetricDefinition,
      },
      project: 'alpha', env: 'prod',
    } as never);

    render(<TooltipProvider><MemoryRouter><Registry /></MemoryRouter></TooltipProvider>);
    const row = (await screen.findByText(metric.name)).closest('tr');
    expect(row).not.toBeNull();
    fireEvent.click(within(row!).getByRole('button', { name: `Review ${metric.name} definition` }));

    const editor = await screen.findByRole('dialog', { name: `Definition · ${metric.name}` });
    expect(within(editor).getByText('Revision 2')).toBeInTheDocument();
    fireEvent.change(within(editor).getByLabelText('Purpose'), {
      target: { value: 'Count users after their first completed onboarding milestone.' },
    });
    fireEvent.click(within(editor).getByRole('button', { name: 'Preview impact' }));

    expect(await within(editor).findByText('1 registered dependency')).toBeInTheDocument();
    fireEvent.click(within(editor).getByRole('button', { name: 'Confirm and apply revision 3' }));

    await waitFor(() => expect(applyMetricDefinition).toHaveBeenCalledWith('alpha', metric.key, {
      expected_revision: 2,
      expected_fingerprint: currentDefinition.fingerprint,
      confirm_impact: true,
      definition: {
        purpose: 'Count users after their first completed onboarding milestone.',
        source: metric.source,
      },
    }));
    await act(async () => undefined);
  });
});
