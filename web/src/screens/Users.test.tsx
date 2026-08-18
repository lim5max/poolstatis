import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

function openCustomPeriod(period: HTMLElement) {
  const trigger = within(period).getByRole('button', { name: /^Period:/ });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: 'Enter', code: 'Enter' });
  fireEvent.click(screen.getByRole('menuitem', { name: /Custom period…/ }));
}

function openFilters() {
  const trigger = screen.getByRole('button', { name: 'Filters' });
  if (trigger.getAttribute('aria-expanded') === 'false') fireEvent.click(trigger);
}

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

  it('keeps the people table compact and moves row details to the actor view', async () => {
    render(<MemoryRouter><Users /></MemoryRouter>);

    expect(await screen.findByRole('heading', { name: 'People', level: 1 })).toBeInTheDocument();
    expect(await screen.findByText('anon_7')).toBeInTheDocument();
    expect(screen.getByText(/^Visitor /)).toHaveAttribute('title', 'Stable display alias; not a verified name');
    expect(screen.getByRole('tab', { name: 'All people' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Groups' })).toBeInTheDocument();
    expect(screen.queryByText('Ordered by last seen in this window')).not.toBeInTheDocument();
    expect(screen.queryByText(/Evidence window:/)).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Registered activity' })).not.toBeInTheDocument();
    expect(screen.queryByText('Data limits')).not.toBeInTheDocument();
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

  it('applies a custom period and keeps ordering evidence out of every table row', async () => {
    const view = render(<MemoryRouter><Users /></MemoryRouter>);
    await screen.findByText('anon_7');

    const initialResult = await operationalQuery.mock.results[0]!.value;
    const pending = deferred<typeof initialResult>();
    operationalQuery.mockImplementationOnce(() => pending.promise);
    const period = screen.getByRole('group', { name: 'Analytics period' });
    openCustomPeriod(period);
    fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '2026-08-01' } });
    fireEvent.change(screen.getByLabelText('End date'), { target: { value: '2026-08-04' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply period' }));

    await waitFor(() => expect(operationalQuery).toHaveBeenLastCalledWith('alpha', expect.objectContaining({
      kind: 'actors',
      from: '2026-08-01T00:00:00.000Z',
      to: '2026-08-05T00:00:00.000Z',
    })));
    expect(screen.getByRole('status')).toHaveTextContent('Updating');
    expect(screen.getByText('anon_7')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Open actor anon_7' })).toHaveAttribute(
      'href',
      '/analyze/users/anon_7?range=30d',
    );
    expect(screen.queryByRole('columnheader', { name: 'Order evidence' })).not.toBeInTheDocument();
    expect(view.container.querySelector('.text-xs')).toBeNull();

    await act(async () => { pending.resolve(initialResult); });
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
    expect(screen.getByRole('link', { name: 'Open actor anon_7' })).toHaveAttribute(
      'href',
      '/analyze/users/anon_7?range=custom&from=2026-08-01&to=2026-08-04',
    );
  });

  it('does not relabel old rows as a pending search result', async () => {
    render(<MemoryRouter><Users /></MemoryRouter>);
    await screen.findByText('anon_7');

    const pending = deferred<never>();
    operationalQuery.mockImplementationOnce(() => pending.promise);
    fireEvent.change(screen.getByLabelText('Exact actor ID'), { target: { value: 'raw-actor-7' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run exact actor search' }));

    await waitFor(() => expect(operationalQuery).toHaveBeenLastCalledWith('alpha', expect.objectContaining({
      search: { kind: 'exact_id', value: 'raw-actor-7' },
    })));
    expect(screen.queryByText('anon_7')).not.toBeInTheDocument();
    expect(screen.getByText('Exact match:')).toBeInTheDocument();
    expect(screen.getByText('resolving canonical actors…')).toBeInTheDocument();
  });

  it('does not place setup capability warnings above the people table', async () => {
    render(<MemoryRouter><Users /></MemoryRouter>);

    expect(await screen.findByText('anon_7')).toBeInTheDocument();
    expect(screen.queryByText('Data limits')).not.toBeInTheDocument();
    expect(screen.queryByText(/Identity enrichment is unavailable/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Canonical actor properties are unavailable/)).not.toBeInTheDocument();
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

    openFilters();
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

    fireEvent.click(screen.getByRole('combobox', { name: 'Queue' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Recently activated · Activation completed' }));

    await waitFor(() => expect(operationalQuery).toHaveBeenLastCalledWith('alpha', expect.objectContaining({
      order: 'interesting_desc',
      interesting: { reason: 'recently_activated', metric: 'activation_completed' },
    })));
    expect(await screen.findByText(/Activation completed ·/)).toBeInTheDocument();
    expect(screen.getByText('Identifies the first meaningful product outcome completed by an actor.')).toBeInTheDocument();
    expect(screen.queryByText(/Stall, risk and segment-change ranking are unavailable/)).not.toBeInTheDocument();
  });

  it('drops a selected queue before querying a new project or environment', async () => {
    const alphaClient = {
      metrics: vi.fn().mockResolvedValue([activationMetric]),
      operationalQuery,
    };
    mockedStore.mockReturnValue({ project: 'alpha', env: 'prod', client: alphaClient } as never);
    const view = render(<MemoryRouter><Users /></MemoryRouter>);
    await screen.findByText('anon_7');
    openFilters();
    fireEvent.click(screen.getByRole('combobox', { name: 'Queue' }));
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
    openFilters();
    fireEvent.click(screen.getByRole('combobox', { name: 'Queue' }));
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

  it('lists real registered group entities instead of inventing groups from actor rows', async () => {
    const schema = vi.fn().mockResolvedValue({
      entity_types: [
        { name: 'user', description: 'Person', prop_schema: {} },
        { name: 'account', description: 'Customer account', prop_schema: {} },
      ],
    });
    const entities = vi.fn().mockResolvedValue([{
      entity_id: 'acct_7',
      properties: { name: 'Northstar', plan: 'team' },
      updated_at: '2026-08-05T00:00:00Z',
    }]);
    mockedStore.mockReturnValue({
      project: 'alpha', env: 'prod',
      client: {
        metrics: vi.fn().mockResolvedValue([]),
        operationalQuery,
        schema,
        entities,
      },
    } as never);

    render(<MemoryRouter><Users /></MemoryRouter>);
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Groups' }), { button: 0, ctrlKey: false });

    expect(await screen.findByText('Northstar')).toBeInTheDocument();
    expect(screen.getByText('acct_7')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(schema).toHaveBeenCalledWith('alpha', 'prod');
    expect(entities).toHaveBeenCalledWith('alpha', {
      entity_type: 'account',
      env: 'prod',
      limit: 50,
    });
  });
});
