import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
  configurable: true,
  value: vi.fn(),
});

const activationMetric = {
  id: 'metric-activation',
  key: 'activation_completed',
  name: 'Activation completed',
  purpose: 'Identifies the first meaningful product outcome completed by an actor.',
  category: 'activation',
  tags: [],
  type: 'unique_actors',
  source: { event: 'activation.completed' },
  status: 'active',
  owner: null,
  deprecation_reason: null,
  deprecated_at: null,
} as const;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

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
        order_reason: 'last_seen_in_window',
        rank_reason: null,
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
        order: 'last_seen_desc',
        next_cursor: null,
        activity_metric: null,
        interesting: null,
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
          ordering: {
            selected: 'last_seen_desc',
            input: 'last_seen',
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

  it('shows factual order evidence with its exact evidence window', async () => {
    render(<MemoryRouter><Users /></MemoryRouter>);

    expect(await screen.findByRole('heading', { name: 'People', level: 1 })).toBeInTheDocument();
    expect(screen.getByText('Ordered by last seen in this window')).toBeInTheDocument();
    expect(screen.getByText(/Evidence window:.*Jul 7, 2026.*Aug 6, 2026/)).toBeInTheDocument();
    expect(screen.getByText(/Stall, risk and segment changes remain unavailable/)).toBeInTheDocument();
    expect(screen.getByText(/Activity properties remain redacted/)).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Observed signals first' })).not.toBeInTheDocument();
  });

  it('requests truthful last-seen order by default', async () => {
    render(<MemoryRouter><Users /></MemoryRouter>);

    await screen.findByText('anon_7');
    expect(operationalQuery).toHaveBeenCalledWith('alpha', expect.objectContaining({
      kind: 'actors',
      env: 'prod',
      order: 'last_seen_desc',
    }));
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

  it('requests and explains a recently activated queue from an active native activation metric', async () => {
    const metrics = vi.fn().mockResolvedValue([activationMetric]);
    mockedStore.mockReturnValue({
      project: 'alpha', env: 'prod',
      client: { metrics, operationalQuery },
    } as never);

    render(<MemoryRouter><Users /></MemoryRouter>);
    await screen.findByText('anon_7');

    operationalQuery.mockResolvedValue({
      kind: 'actors',
      actors: [{
        distinct_id: 'activated_9', raw_actor_count: 1,
        first_seen: '2026-08-04T00:00:00Z', last_seen: '2026-08-05T00:00:00Z',
        total_events: 2, active_days: 2, session_count: null,
        top_events: [{ event: 'activation.completed', count: 1 }],
        pinned_properties: {}, identity_status: 'unknown',
        order_reason: 'recent_activation_in_window',
        rank_reason: {
          kind: 'recently_activated',
          metric_key: 'activation_completed',
          metric_name: 'Activation completed',
          metric_purpose: 'Identifies the first meaningful product outcome completed by an actor.',
          observed_at: '2026-08-05T00:00:00Z',
        },
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
        interesting: {
          reason: 'recently_activated',
          metric: {
            key: 'activation_completed', name: 'Activation completed',
            purpose: 'Identifies the first meaningful product outcome completed by an actor.',
            category: 'activation', source: 'native',
          },
        },
        capabilities: {
          property_filters: { available: false, reason: 'No canonical property source.' },
          pinned_properties: { available: false, reason: 'No pinned property source.' },
          session_count: {
            source: 'canonical_browser_sessions', unavailable_value: null, project_capability: false,
          },
          identity_profile: { available: false, reason: 'No identity profile source.' },
          outcome_rank: { available: true, reason: 'recently_activated' },
          interesting_categories: {
            recently_activated: {
              available: true, requires: 'active_native_activation_metric', metric_count: 1,
            },
            stalled: { available: false, requires: 'purpose_backed_stall_definition' },
            at_risk: { available: false, requires: 'purpose_backed_risk_definition' },
            changed_segment: { available: false, requires: 'trusted_canonical_actor_property_source' },
          },
        },
        provenance: {
          identity_status: 'Only explicit server-owned links are classified.',
          top_events: { registered_only: true, limit: 8 },
          pinned_properties: { source: null, fail_closed: true },
          ordering: {
            selected: 'interesting_desc',
            input: 'activation_event_timestamp',
            relative_to: 'the exact query window',
          },
        },
      },
    });

    fireEvent.click(screen.getAllByRole('combobox')[1]!);
    fireEvent.click(await screen.findByRole('option', { name: 'Recently activated · Activation completed' }));

    await waitFor(() => expect(operationalQuery).toHaveBeenLastCalledWith('alpha', expect.objectContaining({
      order: 'interesting_desc',
      interesting: { reason: 'recently_activated', metric: 'activation_completed' },
    })));
    expect(await screen.findByText('Recently activated in this window')).toBeInTheDocument();
    expect(screen.getByText('Identifies the first meaningful product outcome completed by an actor.')).toBeInTheDocument();
    expect(screen.getByText(/Stall, risk and segment-change ranking are unavailable/)).toBeInTheDocument();
  });

  it('drops a selected queue before querying a new project or environment', async () => {
    const alphaClient = {
      metrics: vi.fn().mockResolvedValue([activationMetric]),
      operationalQuery,
    };
    mockedStore.mockReturnValue({ project: 'alpha', env: 'prod', client: alphaClient } as never);
    const view = render(<MemoryRouter><Users /></MemoryRouter>);
    await screen.findByText('anon_7');
    fireEvent.click(screen.getAllByRole('combobox')[1]!);
    fireEvent.click(await screen.findByRole('option', { name: 'Recently activated · Activation completed' }));
    await waitFor(() => expect(operationalQuery).toHaveBeenLastCalledWith('alpha', expect.objectContaining({
      order: 'interesting_desc',
      interesting: { reason: 'recently_activated', metric: 'activation_completed' },
    })));

    operationalQuery.mockClear();
    const betaRegistry = deferred<never[]>();
    const betaClient = {
      metrics: vi.fn(() => betaRegistry.promise),
      operationalQuery,
    };
    mockedStore.mockReturnValue({ project: 'beta', env: 'dev', client: betaClient } as never);
    view.rerender(<MemoryRouter><Users /></MemoryRouter>);

    await waitFor(() => expect(operationalQuery).toHaveBeenCalledWith('beta', expect.objectContaining({
      env: 'dev',
      order: 'last_seen_desc',
    })));
    expect(operationalQuery.mock.calls.filter(([project]) => project === 'beta'))
      .not.toEqual(expect.arrayContaining([
        expect.arrayContaining([
          'beta',
          expect.objectContaining({ interesting: expect.anything() }),
        ]),
      ]));
    expect(screen.getByRole('combobox', { name: 'Queue' })).toHaveTextContent('All observed people');
    await act(async () => { betaRegistry.resolve([]); });
  });

  it('reconciles registry replacement and ignores a stale async metric response', async () => {
    const initialClient = {
      metrics: vi.fn().mockResolvedValue([activationMetric]),
      operationalQuery,
    };
    mockedStore.mockReturnValue({ project: 'alpha', env: 'prod', client: initialClient } as never);
    const view = render(<MemoryRouter><Users /></MemoryRouter>);
    await screen.findByText('anon_7');
    fireEvent.click(screen.getAllByRole('combobox')[1]!);
    fireEvent.click(await screen.findByRole('option', { name: 'Recently activated · Activation completed' }));
    await waitFor(() => expect(operationalQuery).toHaveBeenLastCalledWith('alpha', expect.objectContaining({
      order: 'interesting_desc',
    })));

    const staleRegistry = deferred<Array<typeof activationMetric>>();
    const staleClient = {
      metrics: vi.fn(() => staleRegistry.promise),
      operationalQuery,
    };
    mockedStore.mockReturnValue({ project: 'alpha', env: 'prod', client: staleClient } as never);
    view.rerender(<MemoryRouter><Users /></MemoryRouter>);

    const currentClient = {
      metrics: vi.fn().mockResolvedValue([]),
      operationalQuery,
    };
    mockedStore.mockReturnValue({ project: 'alpha', env: 'prod', client: currentClient } as never);
    view.rerender(<MemoryRouter><Users /></MemoryRouter>);
    await waitFor(() => expect(currentClient.metrics).toHaveBeenCalled());
    await act(async () => { staleRegistry.resolve([activationMetric]); });

    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Queue' }))
      .toHaveTextContent('All observed people'));
    fireEvent.click(screen.getByRole('combobox', { name: 'Queue' }));
    expect(screen.queryByRole('option', { name: 'Recently activated · Activation completed' }))
      .not.toBeInTheDocument();
  });

  it('never renders rows from the previous project while the next scope is pending or errors', async () => {
    const view = render(<MemoryRouter><Users /></MemoryRouter>);
    await screen.findByText('anon_7');

    let rejectBeta!: (reason: Error) => void;
    const betaResult = new Promise<never>((_resolve, reject) => { rejectBeta = reject; });
    operationalQuery.mockImplementationOnce(() => betaResult);
    mockedStore.mockReturnValue({
      project: 'beta', env: 'prod',
      client: {
        metrics: vi.fn().mockResolvedValue([]),
        operationalQuery,
      },
    } as never);

    view.rerender(<MemoryRouter><Users /></MemoryRouter>);
    expect(screen.queryByText('anon_7')).not.toBeInTheDocument();

    rejectBeta(new Error('beta unavailable'));
    expect(await screen.findByText('beta unavailable')).toBeInTheDocument();
    expect(screen.queryByText('anon_7')).not.toBeInTheDocument();
  });
});
