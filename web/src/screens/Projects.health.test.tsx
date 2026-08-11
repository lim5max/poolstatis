import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { useStore } from '../store';
import { Projects } from './Projects';

vi.mock('../store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../store')>()),
  useStore: vi.fn(),
}));

describe('project portfolio health', () => {
  it('shows recent usage, outcome availability and concrete attention reasons', () => {
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
      project: 'alpha', setProject: vi.fn(), tokenKind: 'secret', projectScope: 'project',
      account: null, client: { deleteProject: vi.fn() }, refreshProjects: vi.fn(),
    } as never);

    render(<MemoryRouter><Projects /></MemoryRouter>);

    expect(screen.getByText('Project portfolio')).toBeInTheDocument();
    expect(screen.getAllByText('Needs attention').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('12 · 24h / 80 · 7d')).toBeInTheDocument();
    expect(screen.getByText('1 active contract')).toBeInTheDocument();
    expect(screen.getByText('2 attention items')).toBeInTheDocument();
    expect(screen.getByText('Off-standard event volume')).toBeInTheDocument();
    fireEvent.click(screen.getByText('4 server guardrails'));
    expect(screen.getByText('Registered coverage is at least 99%')).toBeInTheDocument();
    expect(screen.getByText(/Observed 94%/)).toBeInTheDocument();
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
});
