import { fireEvent, render, screen, within } from '@testing-library/react';
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
  return {
    client,
    project: 'alpha',
    env: 'prod',
    availableEnvs: ['prod'],
    setEnv: vi.fn(),
  } as never;
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

  it('keeps visitors, sessions and page views distinct with responsive count-and-percentage breakdowns', async () => {
    const webMetric = {
      ...metric,
      id: 'web', key: 'web_page_views', name: 'Web page views',
      source: { event: 'page.viewed' },
    };
    const webAnalytics = vi.fn().mockResolvedValue({
      kind: 'web_analytics',
      summary: { visitors: 8, sessions: 11, page_views: 20 },
      breakdowns: {
        country: [{ value: 'US', visitors: 6, sessions: 8, page_views: 15, percentage: 75 }],
        device: [{ value: 'mobile', visitors: 5, sessions: 7, page_views: 12, percentage: 60 }],
        browser: [], os: [], source: [],
      },
      meta: {
        computed_at: '2026-07-27T00:00:00Z',
        truncated_dimensions: ['country'],
        definitions: {
          visitors: 'Unique resolved actors.',
          sessions: 'Distinct session ids.',
          page_views: 'Accepted stored page-view events.',
        },
        privacy: 'Raw IP is not stored.',
      },
    });
    mockedStore.mockReturnValue(store({
      properties: vi.fn().mockResolvedValue([]), actorLinks: vi.fn().mockResolvedValue({ links: [], audit: [] }),
      sources: vi.fn().mockResolvedValue([]), metrics: vi.fn().mockResolvedValue([webMetric]),
      contracts: vi.fn().mockResolvedValue([]), exportContracts: vi.fn(),
      measurementTrust: vi.fn().mockResolvedValue({
        status: 'trusted', primary_metric: { key: webMetric.key, purpose: webMetric.purpose, category: 'acquisition', observed_events: 20, observed_actors: 8, registered_coverage: 1 },
        identity: { distinct_id_coverage: 1, raw_actors: 8, resolved_actors: 8 }, properties: [], blockers: [], warnings: [],
      }),
      trend: vi.fn().mockResolvedValue({ kind: 'trend', series: [], meta: {} }),
      webAnalytics,
    }));
    render(<MemoryRouter><Measurement /></MemoryRouter>);
    await screen.findByText('Web analytics');
    fireEvent.click(screen.getByRole('button', { name: 'Run traffic summary' }));
    expect(await screen.findByText('Visitors')).toBeInTheDocument();
    expect(screen.getByText('Sessions')).toBeInTheDocument();
    expect(screen.getByText('Page views')).toBeInTheDocument();
    expect(screen.getByText('75%')).toBeInTheDocument();
    expect(screen.getByText('60%')).toBeInTheDocument();
    expect(screen.getByText('Unique resolved actors.')).toBeInTheDocument();
    expect(screen.getByText(/Showing top 8/)).toBeInTheDocument();
    expect(webAnalytics).toHaveBeenCalledWith('alpha', expect.objectContaining({
      metric: 'web_page_views', dimensions: ['country', 'device', 'browser', 'os', 'source'], env: 'prod',
    }));
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

  it('keeps customer capture recency while exposing the full Visual Experience setup', async () => {
    mockedStore.mockReturnValue(store({
      experienceSurfaces: vi.fn().mockResolvedValue([{
        id: 's1', key: 'checkout', name: 'Checkout', purpose: 'Understand checkout friction.',
        status: 'active', created_at: '2026-07-01', updated_at: '2026-07-01',
        last_capture_at: '2026-07-27T10:00:00.000Z',
      }]),
      experienceRoutes: vi.fn().mockResolvedValue([]),
      experienceSnapshots: vi.fn().mockResolvedValue([]),
      interactionMap: vi.fn().mockResolvedValue({
        kind: 'interaction_map',
        surface: { key: 'checkout', name: 'Checkout', purpose: 'Understand checkout friction.', status: 'active' },
        grid: 8,
        cells: [{ x: 2, y: 3, count: 4, actors: 3 }],
        labels: [{ label: 'checkout.submit', count: 4, actors: 3 }],
      }),
    }));
    render(<Experience />);
    expect(await screen.findByText(/Last accepted capture/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View click details' })).toHaveAttribute('href', '#experience-evidence');
    expect(screen.getByText(/aggregate maps · no DOM replay/)).toBeInTheDocument();
    expect(screen.getByText('Capture the first page version')).toBeInTheDocument();
    expect(screen.getByText('Add a deploy snapshot')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Load aggregate clicks' }));
    expect(await screen.findByText('checkout.submit')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /4 accepted clicks/ })).toBeInTheDocument();
  });
});
