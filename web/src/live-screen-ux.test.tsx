import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Experience } from './screens/Experience';
import { Experiments } from './screens/Experiments';
import { Measurement } from './screens/Measurement';
import { Registry } from './screens/Registry';
import { useStore } from './store';

vi.mock('./store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./store')>()),
  useStore: vi.fn(),
}));

const mockedStore = vi.mocked(useStore);
const metric = {
  id: 'm1', key: 'landing_visits', name: 'Landing visits',
  purpose: 'Count accepted landing page visits for acquisition reporting.',
  category: 'acquisition', tags: [], type: 'count',
  source: { event: 'landing.page_viewed' }, status: 'active',
  owner: null, deprecation_reason: null, deprecated_at: null,
} as const;

function store(client: Record<string, unknown>) {
  return { client, project: 'alpha', env: 'prod' } as never;
}

describe('live customer screen UX', () => {
  beforeEach(() => vi.clearAllMocks());

  it('keeps funnel purpose and steps in a responsive summary with an accessible detail toggle', async () => {
    mockedStore.mockReturnValue(store({
      schema: vi.fn().mockResolvedValue({
        metrics: [], entity_types: [], observed_events_30d: [], properties: [], identity: {},
        sources: [], project: { slug: 'alpha', name: 'Alpha' }, env: 'prod',
        funnels: [{
          id: 'f1', key: 'signup', name: 'Signup',
          goal: 'Measure whether qualified visitors reach a completed account.',
          window_seconds: 604800,
          steps: [
            { metric_key: 'landing_visits', label: 'Landing viewed' },
            { metric_key: 'signup_started', label: 'Signup started' },
            { metric_key: 'signup_completed', label: 'Signup completed' },
          ],
        }],
      }),
    }));
    render(<MemoryRouter><Registry /></MemoryRouter>);
    const funnelsTab = await screen.findByRole('tab', { name: /Funnels/ });
    fireEvent.keyDown(funnelsTab, { key: 'Enter' });
    const summary = screen.getByTestId('funnel-summary-signup');
    expect(summary).toHaveClass('grid');
    expect(within(summary).getByText('3 steps')).toBeInTheDocument();
    const toggle = within(summary).getByRole('button', { name: /Show Signup steps/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(screen.getByText('signup_completed')).toBeInTheDocument();
  });

  it('groups measurement trust and reveals repeated detail only on demand', async () => {
    mockedStore.mockReturnValue(store({
      properties: vi.fn().mockResolvedValue([]),
      actorLinks: vi.fn().mockResolvedValue({ links: [], audit: [] }),
      sources: vi.fn().mockResolvedValue([]),
      metrics: vi.fn().mockResolvedValue([metric]),
      contracts: vi.fn().mockResolvedValue([]),
      measurementTrust: vi.fn().mockResolvedValue({
        status: 'untrusted',
        primary_metric: { key: metric.key, purpose: metric.purpose, category: 'acquisition', observed_events: 0, observed_actors: 0, registered_coverage: 0 },
        identity: { distinct_id_coverage: 0, raw_actors: 0, resolved_actors: 0 },
        properties: [],
        blockers: [{ code: 'no_events', message: 'No accepted events.', next_action: 'Check ingest and CORS.' }],
        warnings: [],
      }),
      trend: vi.fn().mockResolvedValue({ kind: 'trend', series: [], meta: {} }),
      exportContracts: vi.fn(),
    }));
    render(<MemoryRouter><Measurement /></MemoryRouter>);
    expect(await screen.findByText('1 untrusted')).toBeInTheDocument();
    expect(screen.getByText('0 observations')).toBeInTheDocument();
    expect(screen.queryByText('No accepted events.')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Review Landing visits/ }));
    expect(screen.getByText('No accepted events.')).toBeInTheDocument();
    expect(screen.getByText(/Check ingest and CORS/)).toBeInTheDocument();
  });

  it('runs a real UTM report from canonical metric breakdowns and labels missing attribution', async () => {
    const trend = vi.fn()
      .mockResolvedValueOnce({ kind: 'trend', series: [{ bucket: '2026-07-01', value: 8, breakdown_value: 'google' }, { bucket: '2026-07-01', value: 2, breakdown_value: '(none)' }], meta: {} })
      .mockResolvedValueOnce({ kind: 'trend', series: [{ bucket: '2026-07-01', value: 10, breakdown_value: 'organic' }], meta: {} })
      .mockResolvedValueOnce({ kind: 'trend', series: [{ bucket: '2026-07-01', value: 10, breakdown_value: 'launch' }], meta: {} });
    mockedStore.mockReturnValue(store({
      properties: vi.fn().mockResolvedValue([]), actorLinks: vi.fn().mockResolvedValue({ links: [], audit: [] }),
      sources: vi.fn().mockResolvedValue([]), metrics: vi.fn().mockResolvedValue([metric]),
      contracts: vi.fn().mockResolvedValue([]),
      measurementTrust: vi.fn().mockResolvedValue({
        status: 'trusted', primary_metric: { key: metric.key, purpose: metric.purpose, category: 'acquisition', observed_events: 10, observed_actors: 8, registered_coverage: 1 },
        identity: { distinct_id_coverage: 1, raw_actors: 8, resolved_actors: 8 }, properties: [], blockers: [], warnings: [],
      }),
      trend, exportContracts: vi.fn(),
    }));
    render(<MemoryRouter><Measurement /></MemoryRouter>);
    await screen.findByText('Acquisition / UTM');
    fireEvent.click(screen.getByRole('button', { name: 'Run UTM report' }));
    await screen.findByText('google');
    expect(screen.getByText('Direct / unknown')).toBeInTheDocument();
    expect(screen.getByText('80%')).toBeInTheDocument();
    expect(trend).toHaveBeenCalledWith('alpha', expect.objectContaining({ metric: 'landing_visits', breakdown: { property: '$utm_source' }, env: 'prod' }));
    expect(screen.getByRole('link', { name: 'Open raw events' })).toHaveAttribute('href', expect.stringContaining('landing.page_viewed'));
  });

  it('keeps feature and experiment forms behind task-oriented actions', async () => {
    mockedStore.mockReturnValue(store({
      flags: vi.fn().mockResolvedValue([]), experiments: vi.fn().mockResolvedValue([]),
      metrics: vi.fn().mockResolvedValue([metric]),
    }));
    render(<Experiments />);
    expect(await screen.findByText('Plan a measured rollout')).toBeInTheDocument();
    expect(screen.getByText('Draft')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('running experiment')).toBeInTheDocument();
    expect(screen.getByText((_, element) => element?.tagName === 'P' && Boolean(element.textContent?.includes('record first exposure')) && Boolean(element.textContent?.includes('outcome events only after that exposure')))).toBeInTheDocument();
    expect(screen.queryByLabelText('Flag key')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Create feature flag' }));
    expect(screen.getByLabelText('Flag key')).toBeInTheDocument();
    expect(screen.getByText('Landing CTA example')).toBeInTheDocument();
  });

  it('shows capture recency and keeps scroll maps behind the Visual Experience Maps boundary', async () => {
    mockedStore.mockReturnValue(store({
      experienceSurfaces: vi.fn().mockResolvedValue([{
        id: 's1', key: 'checkout', name: 'Checkout', purpose: 'Understand checkout friction.',
        status: 'active', created_at: '2026-07-01', updated_at: '2026-07-01',
        last_capture_at: '2026-07-27T10:00:00.000Z',
      }]),
      interactionMap: vi.fn().mockResolvedValue({
        kind: 'interaction_map', surface: { key: 'checkout', name: 'Checkout', purpose: 'Understand checkout friction.', status: 'active' },
        grid: 8, cells: [], labels: [],
      }),
    }));
    render(<Experience />);
    expect(await screen.findByText(/Last accepted capture/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View click / session scroll' })).toHaveAttribute('href', '#experience-evidence');
    expect(screen.getByText(/does not expose a replay browser or captured page content/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Load evidence' }));
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Scroll evidence' })).toBeEnabled());
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Scroll evidence' }), { key: 'Enter' });
    expect(screen.getByText('Cross-session scroll map is not available here')).toBeInTheDocument();
    expect(screen.getByText(/Visual Experience Maps capability/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Known session' })).toHaveAttribute('href', '#experience-session');
  });
});
