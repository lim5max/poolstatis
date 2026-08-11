import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../store';
import { Users } from './Users';

vi.mock('../store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../store')>()),
  useStore: vi.fn(),
}));

const mockedStore = vi.mocked(useStore);
const operationalQuery = vi.fn();

describe('People list', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    operationalQuery.mockResolvedValue({
      kind: 'actors',
      actors: [{
        distinct_id: 'anon_7', raw_actor_count: 1,
        first_seen: '2026-08-01T00:00:00Z', last_seen: '2026-08-05T00:00:00Z',
        total_events: 4, active_days: 2, session_count: null,
        top_events: [{ event: 'page.viewed', count: 4 }], pinned_properties: {}, identity_status: 'unknown',
        interesting_score: 406,
        rank_reasons: ['first_observed_in_final_7d_with_multiple_active_days'],
        rank_evidence_window: {
          from: '2026-07-07T00:00:00Z',
          to: '2026-08-06T00:00:00Z',
        },
      }],
      meta: {
        computed_at: '2026-08-06T00:00:00Z',
        date_range: { from: '2026-07-07T00:00:00Z', to: '2026-08-06T00:00:00Z' },
        sampling: null,
        source: 'native',
        limit: 50,
        order: 'interesting_desc',
        next_cursor: null,
        activity_metric: null,
        capabilities: {
          property_filters: {
            available: false,
            reason: 'No deterministic trusted canonical actor-property source exists.',
          },
          pinned_properties: {
            available: false,
            reason: 'No approved deterministic pinned-property source exists.',
          },
          session_count: {
            source: 'canonical_browser_sessions',
            unavailable_value: null,
            project_capability: false,
          },
          identity_profile: {
            available: false,
            reason: 'Only explicit server-owned identity links are available.',
          },
          outcome_rank: {
            available: false,
            reason: 'No purpose-backed outcome definition is selected.',
          },
          interesting_categories: {
            recently_activated: { available: false, requires: 'purpose_backed_activation_metric_or_funnel' },
            stalled: { available: false, requires: 'purpose_backed_stall_definition' },
            at_risk: { available: false, requires: 'purpose_backed_risk_definition' },
            changed_segment: { available: false, requires: 'trusted_canonical_actor_property_source' },
          },
        },
        provenance: {
          identity_status: 'Only explicit server-owned links are classified.',
          top_events: { registered_only: true, limit: 8 },
          pinned_properties: { source: null, fail_closed: true },
          interesting_rank: {
            inputs: ['first_seen', 'last_seen', 'active_days', 'total_events'],
            excludes: ['properties', 'hidden profiles', 'predicted intent'],
            relative_to: 'the exact query window',
          },
        },
      },
    });
    mockedStore.mockReturnValue({
      project: 'alpha', env: 'prod',
      client: {
        metrics: vi.fn().mockResolvedValue([]),
        operationalQuery,
      },
    } as never);
  });

  it('shows a factual rank reason with its exact evidence window', async () => {
    render(<MemoryRouter><Users /></MemoryRouter>);

    expect(await screen.findByRole('heading', { name: 'People', level: 1 })).toBeInTheDocument();
    expect(screen.getByText('First in-window observation fell in the final 7 days, with activity on multiple days')).toBeInTheDocument();
    expect(screen.getByText(/Evidence window:.*Jul 7, 2026.*Aug 6, 2026/)).toBeInTheDocument();
    expect(screen.getByText(/does not infer risk/)).toBeInTheDocument();
    expect(screen.getByText(/Activity properties remain redacted/)).toBeInTheDocument();
  });

  it('consolidates missing identity, property and outcome capabilities into one data-health block', async () => {
    render(<MemoryRouter><Users /></MemoryRouter>);

    expect(await screen.findByRole('heading', { name: 'People data health' })).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { name: 'People data health' })).toHaveLength(1);
    expect(screen.getByText(/Identity enrichment is unavailable/)).toBeInTheDocument();
    expect(screen.getByText(/Canonical actor properties are unavailable/)).toBeInTheDocument();
    expect(screen.getByText(/Activation, stall, risk and segment-change ranking are unavailable/)).toBeInTheDocument();
    expect(screen.queryByText('Unknown')).not.toBeInTheDocument();
    expect(screen.queryByText('Not assessed')).not.toBeInTheDocument();
    expect(screen.queryByText('Unavailable')).not.toBeInTheDocument();
  });

  it('keeps exact-ID lookup in the bounded actors query', async () => {
    render(<MemoryRouter><Users /></MemoryRouter>);
    await screen.findByText('anon_7');

    fireEvent.change(screen.getByLabelText('Exact actor ID'), { target: { value: ' raw-actor-7 ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run exact actor search' }));

    await waitFor(() => expect(operationalQuery).toHaveBeenLastCalledWith('alpha', expect.objectContaining({
      kind: 'actors',
      env: 'prod',
      search: { kind: 'exact_id', value: 'raw-actor-7' },
      propertyFilters: [],
      limit: 50,
    })));
  });
});
