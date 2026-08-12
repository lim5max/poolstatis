import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { useStore } from '../store';
import { Projects } from './Projects';

vi.mock('../store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../store')>()),
  useStore: vi.fn(),
}));

describe('project portfolio health', () => {
  it('shows env-scoped accepted cycle usage, outcome availability and concrete attention reasons', async () => {
    const projectPortfolio = vi.fn().mockResolvedValue({
      schema_version: 1,
      generated_at: '2026-08-11T12:00:00.000Z',
      scope: {
        credential: 'project', environment: 'prod',
        usage_cycle: { from: '2026-08-01T00:00:00.000Z', to: '2026-09-01T00:00:00.000Z', timezone: 'UTC', basis: 'ingest_time' },
      },
      projects: [{
        slug: 'alpha', name: 'Alpha', timezone: 'UTC', environment: 'prod',
        active_metrics: 1, proposed_metrics: 2, active_outcome_contracts: 1,
        funnels: 1, events_24h: 12, events_7d: 80, events_30d: 310,
        last_event_at: '2026-08-11T10:00:00Z', registered_coverage_30d: 0.94,
        current_usage: {
          meter: 'events_stored', period: '2026-08', accepted_events: 42,
          last_ingest_at: '2026-08-11T11:00:00Z', source: 'usage_ledger', basis: 'ingest_time',
        },
        key_outcome_available: true,
        key_outcome_readiness: {
          state: 'ready', contract_key: 'activation', metric_key: 'activated_users',
          evaluated_at: '2026-08-11T12:00:00Z',
          guardrail: {
            id: 'key_outcome_queryable', state: 'pass', reason_code: 'query_succeeded',
            reason: 'The typed 30-day outcome query completed.', observed_events: 48,
          },
        },
        health: 'needs_attention',
        attention: ['Off-standard event volume', '2 metrics awaiting review'],
        health_evaluation: {
          source: 'server', evaluated_at: '2026-08-11T12:00:00Z',
          guardrails: [
            { id: 'recent_data', state: 'pass', observed: 310, expectation: 'More than 0 accepted events in 30 days' },
            { id: 'registered_coverage', state: 'fail', observed: 0.94, expectation: 'Registered coverage is at least 99%' },
            { id: 'active_outcome', state: 'pass', observed: 1, expectation: 'At least 1 active measurement contract' },
            { id: 'metric_review_queue', state: 'fail', observed: 2, expectation: 'No proposed metrics awaiting review' },
          ],
        },
      }],
    });
    vi.mocked(useStore).mockReturnValue({
      projects: [{
        slug: 'alpha', name: 'Alpha', timezone: 'UTC', active_metrics: 1, proposed_metrics: 2, active_outcome_contracts: 1,
        funnels: 1, events_24h: 12, events_7d: 80, events_30d: 310,
        last_event_at: '2026-08-11T10:00:00Z', registered_coverage_30d: 0.94,
        key_outcome_available: true, health: 'needs_attention',
        attention: ['Off-standard event volume', '2 metrics awaiting review'],
        health_evaluation: {
          source: 'server', evaluated_at: '2026-08-11T12:00:00Z',
          guardrails: [
            { id: 'recent_data', state: 'pass', observed: 310, expectation: 'More than 0 accepted events in 30 days' },
            { id: 'registered_coverage', state: 'fail', observed: 0.94, expectation: 'Registered coverage is at least 99%' },
            { id: 'active_outcome', state: 'pass', observed: 1, expectation: 'At least 1 active measurement contract' },
            { id: 'metric_review_queue', state: 'fail', observed: 2, expectation: 'No proposed metrics awaiting review' },
          ],
        },
      }],
      project: 'alpha', setProject: vi.fn(), tokenKind: 'secret', projectScope: 'project', env: 'prod',
      account: null, client: { deleteProject: vi.fn(), projectPortfolio }, refreshProjects: vi.fn(),
    } as never);

    render(<MemoryRouter><Projects /></MemoryRouter>);

    expect(screen.getByText('Project portfolio')).toBeInTheDocument();
    const projectRow = await screen.findByRole('row', { name: /Alpha/ });
    expect(projectRow).toHaveTextContent('42 accepted · 2026-08');
    expect(screen.getAllByText('Needs attention').length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText('310 events · 30d')).not.toBeInTheDocument();
    expect(screen.getByText(/Last ingest/)).toBeInTheDocument();
    expect(screen.getByText('Queryable')).toBeInTheDocument();
    expect(screen.getByText('activated_users')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Outcome guardrail'));
    expect(screen.getByText('The typed 30-day outcome query completed.')).toBeInTheDocument();
    expect(screen.getByText('48 observed events')).toBeInTheDocument();
    expect(screen.getByText('2 attention items')).toBeInTheDocument();
    expect(screen.getByText('Off-standard event volume')).toBeInTheDocument();
    fireEvent.click(screen.getByText('4 server guardrails'));
    expect(screen.getByText('Registered coverage is at least 99%')).toBeInTheDocument();
    expect(screen.getByText(/Observed 94%/)).toBeInTheDocument();
    expect(projectPortfolio).toHaveBeenCalledWith('prod');
  });

  it('keeps project creation behind an explicit action', () => {
    vi.mocked(useStore).mockReturnValue({
      projects: [{
        slug: 'alpha', name: 'Alpha', timezone: 'UTC', active_metrics: 1, proposed_metrics: 0, active_outcome_contracts: 1,
        funnels: 1, events_24h: 12, events_7d: 80, events_30d: 310,
        last_event_at: '2026-08-11T10:00:00Z', registered_coverage_30d: 1,
        key_outcome_available: true, health: 'healthy', attention: [],
      }],
      project: 'alpha', setProject: vi.fn(), tokenKind: 'personal', projectScope: 'org', env: 'prod',
      account: null,
      client: { deleteProject: vi.fn(), createProject: vi.fn(), compareProjects: vi.fn() },
      refreshProjects: vi.fn(),
    } as never);

    render(<MemoryRouter><Projects /></MemoryRouter>);

    expect(screen.queryByLabelText('Slug')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'New project' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('New project');
    expect(screen.getByLabelText('Slug')).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toBeInTheDocument();
  });

  it('applies a contributor deep link to the requested project and environment', async () => {
    const setProject = vi.fn();
    vi.mocked(useStore).mockReturnValue({
      projects: [
        { slug: 'alpha', name: 'Alpha', timezone: 'UTC', active_metrics: 1, funnels: 0, events_30d: 3 },
        { slug: 'bravo', name: 'Bravo', timezone: 'UTC', active_metrics: 1, funnels: 0, events_30d: 4 },
      ],
      project: 'alpha', setProject, tokenKind: 'personal', projectScope: 'org', env: 'prod',
      account: null, client: { deleteProject: vi.fn(), compareProjects: vi.fn() }, refreshProjects: vi.fn(),
    } as never);

    render(<MemoryRouter initialEntries={['/projects?project=bravo&env=staging']}><Projects /></MemoryRouter>);

    await waitFor(() => expect(setProject).toHaveBeenCalledWith('bravo', 'staging'));
    expect(screen.getByRole('row', { name: /Bravo/ })).toHaveAttribute('data-focus-project', 'true');
  });
});
