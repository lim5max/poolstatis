import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Experience } from './screens/Experience';
import { Experiments } from './screens/Experiments';
import { Measurement } from './screens/Measurement';
import { Registry } from './screens/Registry';
import { useStore } from './store';
import { TooltipProvider } from './components/ui/tooltip';

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
    render(<TooltipProvider><MemoryRouter><Registry /></MemoryRouter></TooltipProvider>);
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

  it('omits a metric key when it only repeats the human-readable name', async () => {
    mockedStore.mockReturnValue(store({
      schema: vi.fn().mockResolvedValue({
        metrics: [metric], metric_categories: [], entity_types: [], observed_events_30d: [],
        properties: [], identity: {}, sources: [], funnels: [],
        project: { slug: 'alpha', name: 'Alpha' }, env: 'prod',
      }),
    }));
    render(<TooltipProvider><MemoryRouter><Registry /></MemoryRouter></TooltipProvider>);
    expect(await screen.findByText('Landing visits')).toBeInTheDocument();
    expect(screen.queryByText('landing_visits', { exact: true })).not.toBeInTheDocument();
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
    render(<TooltipProvider><MemoryRouter><Measurement /></MemoryRouter></TooltipProvider>);
    expect(await screen.findByText('1 untrusted')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Explain 1 untrusted' })).toBeInTheDocument();
    expect(screen.getByText('0 observations')).toBeInTheDocument();
    expect(screen.queryByText('landing_visits', { exact: true })).not.toBeInTheDocument();
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
    render(<TooltipProvider><MemoryRouter><Measurement /></MemoryRouter></TooltipProvider>);
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
      engagement: {
        measured_sessions: 9, incomplete_sessions: 2, engaged_sessions: 6,
        bounce_sessions: 3, single_page_sessions: 7,
        timed_page_views: 18, total_page_views: 20, timed_page_coverage: 0.9,
        foreground_ms: 125_000, session_span_ms: 240_000,
      },
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
          engaged_sessions: 'Measured engagement.',
          bounce_sessions: 'Count of measured sessions without engagement.',
          single_page_sessions: 'Single-page sessions.',
          foreground_ms: 'Visible focused time.',
          session_span_ms: 'Wall-clock span.',
        },
        accepted_event_accounting: 'Accepted stored events.',
        privacy: 'Raw IP is not stored.',
        country_attribution: {
          label: 'IP Geolocation by DB-IP',
          url: 'https://db-ip.com',
        },
      },
    });
    const webSessions = vi.fn().mockResolvedValue({
      kind: 'web_sessions',
      sessions: [{
        session_id: 'session-1', actor_id: 'actor-1',
        started_at: '2026-07-27T00:00:00Z', ended_at: '2026-07-27T00:00:20Z',
        page_views: 1, timed_page_views: 1, foreground_ms: 15_000, session_span_ms: 20_000,
        engaged: true, bounce: false, single_page: true, complete: true,
      }],
      meta: { computed_at: '2026-07-27T00:00:21Z', total: 1, truncated: false, definitions: {} },
    });
    const webSession = vi.fn().mockResolvedValue({
      kind: 'web_session',
      summary: {
        session_id: 'session-1', actor_id: 'actor-1',
        started_at: '2026-07-27T00:00:00Z', ended_at: '2026-07-27T00:00:20Z',
        page_views: 1, timed_page_views: 1, foreground_ms: 15_000, session_span_ms: 20_000,
        engaged: true, bounce: false, single_page: true, complete: true,
      },
      pages: [{
        page_view_id: 'page-1', session_id: 'session-1', path: '/pricing',
        viewed_at: '2026-07-27T00:00:00Z', last_snapshot_at: '2026-07-27T00:00:15Z',
        sequence: 2, foreground_ms: 15_000, elapsed_ms: 15_000, max_scroll_pct: 75,
        interaction_count: 2, reason: 'pagehide', complete: true,
      }],
      meta: { computed_at: '2026-07-27T00:00:21Z', privacy: 'No replay.' },
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
      webAnalytics, webSessions, webSession,
    }));
    render(<TooltipProvider><MemoryRouter><Measurement /></MemoryRouter></TooltipProvider>);
    await screen.findByText('Web analytics');
    fireEvent.click(screen.getByRole('button', { name: 'Run traffic summary' }));
    expect(await screen.findByText('Visitors')).toBeInTheDocument();
    expect(screen.getByText('Sessions')).toBeInTheDocument();
    expect(screen.getByText('Page views')).toBeInTheDocument();
    expect(screen.getByText('Measured engagement')).toBeInTheDocument();
    expect(screen.getByText('6 / 11')).toBeInTheDocument();
    expect(screen.getByText('2m 5s')).toBeInTheDocument();
    expect(screen.getByText(/2 incomplete sessions/)).toBeInTheDocument();
    expect(screen.getByText('75%')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'IP Geolocation by DB-IP' })).toHaveAttribute(
      'href',
      'https://db-ip.com',
    );
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Device' }), { key: 'Enter' });
    expect(screen.getByText('60%')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Visitors' })).toBeInTheDocument();
    expect(screen.getByText(/Showing 1 of 1 returned groups/)).toBeInTheDocument();
    expect(webAnalytics).toHaveBeenCalledWith('alpha', expect.objectContaining({
      metric: 'web_page_views', dimensions: ['country', 'device', 'browser', 'os', 'source'], env: 'prod',
    }));
    fireEvent.click(screen.getByRole('button', { name: 'Load recent sessions' }));
    expect(await screen.findByText('15s')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Inspect' }));
    expect(await screen.findByText('/pricing')).toBeInTheDocument();
  });

  it('bounds 100+ dimension values behind one searchable ranked explorer', async () => {
    const webMetric = {
      ...metric,
      id: 'web-many', key: 'web_page_views', name: 'Web page views',
      source: { event: 'page.viewed' },
    };
    const longSource = `partner-${'very-long-source-label-'.repeat(12)}`;
    const sourceCount = 1_020;
    const pageViews = sourceCount * (sourceCount + 1) / 2;
    const sources = Array.from({ length: sourceCount }, (_, index) => ({
      value: index === sourceCount - 1 ? longSource : `source-${String(index).padStart(4, '0')}`,
      visitors: index + 1,
      sessions: index + 1,
      page_views: index + 1,
      percentage: Math.round(((index + 1) / pageViews) * 1_000) / 10,
    }));
    mockedStore.mockReturnValue(store({
      properties: vi.fn().mockResolvedValue([]), actorLinks: vi.fn().mockResolvedValue({ links: [], audit: [] }),
      sources: vi.fn().mockResolvedValue([]), metrics: vi.fn().mockResolvedValue([webMetric]),
      contracts: vi.fn().mockResolvedValue([]), exportContracts: vi.fn(),
      measurementTrust: vi.fn().mockResolvedValue({
        status: 'trusted', primary_metric: { key: webMetric.key, purpose: webMetric.purpose, category: 'acquisition', observed_events: pageViews, observed_actors: sourceCount, registered_coverage: 1 },
        identity: { distinct_id_coverage: 1, raw_actors: sourceCount, resolved_actors: sourceCount }, properties: [], blockers: [], warnings: [],
      }),
      trend: vi.fn().mockResolvedValue({ kind: 'trend', series: [], meta: {} }),
      webAnalytics: vi.fn().mockResolvedValue({
        kind: 'web_analytics',
        summary: { visitors: sourceCount, sessions: sourceCount, page_views: pageViews },
        engagement: {
          measured_sessions: 0, incomplete_sessions: sourceCount, engaged_sessions: 0,
          bounce_sessions: 0, single_page_sessions: sourceCount,
          timed_page_views: 0, total_page_views: pageViews, timed_page_coverage: 0,
          foreground_ms: 0, session_span_ms: 0,
        },
        breakdowns: {
          country: [{ value: 'unknown', visitors: sourceCount, sessions: sourceCount, page_views: pageViews, percentage: 100 }],
          device: [], browser: [], os: [], source: sources,
        },
        meta: {
          computed_at: '2026-07-27T00:00:00Z',
          truncated_dimensions: ['source'],
          definitions: {
            visitors: 'Unique resolved actors.',
            sessions: 'Distinct session ids.',
            page_views: 'Accepted stored page-view events.',
            engaged_sessions: 'Measured engagement.',
            bounce_sessions: 'Count of measured sessions without engagement.',
            single_page_sessions: 'Single-page sessions.',
            foreground_ms: 'Visible focused time.',
            session_span_ms: 'Wall-clock span.',
          },
          accepted_event_accounting: 'Accepted stored events.',
          privacy: 'Raw IP is not stored.',
        },
      }),
    }));
    render(<TooltipProvider><MemoryRouter><Measurement /></MemoryRouter></TooltipProvider>);
    await screen.findByText('Web analytics');
    fireEvent.click(screen.getByRole('button', { name: 'Run traffic summary' }));
    expect(await screen.findByText('Unknown')).toBeInTheDocument();

    fireEvent.keyDown(screen.getByRole('tab', { name: 'Source' }), { key: 'Enter' });
    expect(screen.getByRole('tabpanel')).toBeInTheDocument();
    let rankedList = screen.getByRole('list', { name: 'Source ranked by page views' });
    expect(within(rankedList).getAllByRole('listitem')).toHaveLength(8);
    expect(within(rankedList).getByTitle(longSource)).toBeInTheDocument();
    expect(screen.getByText(/42 more returned/)).toBeInTheDocument();
    expect(screen.getByText(/at least 1 more beyond the top 50/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'View all' }));
    rankedList = screen.getByRole('list', { name: 'Source ranked by page views' });
    expect(rankedList).toHaveClass('max-h-96', 'overflow-y-auto');
    expect(within(rankedList).getAllByRole('listitem')).toHaveLength(50);
    const search = screen.getByRole('textbox', { name: 'Search source groups' });
    fireEvent.change(search, { target: { value: 'very-long-source' } });
    expect(within(rankedList).getAllByRole('listitem')).toHaveLength(1);
    expect(within(rankedList).getByTitle(longSource)).toHaveClass('truncate');
  });

  it('keeps feature and experiment forms behind task-oriented actions', async () => {
    mockedStore.mockReturnValue(store({
      flags: vi.fn().mockResolvedValue([]), experiments: vi.fn().mockResolvedValue([]),
      metrics: vi.fn().mockResolvedValue([metric]),
    }));
    render(<TooltipProvider><Experiments /></TooltipProvider>);
    expect(await screen.findByText('Plan a measured rollout')).toBeInTheDocument();
    expect(screen.getByText('Draft')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('Running')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Explain draft status' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Explain active status' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Explain running experiment status' })).toBeInTheDocument();
    expect(screen.queryByText((_, element) => element?.tagName === 'P' && Boolean(element.textContent?.includes('record first exposure')) && Boolean(element.textContent?.includes('outcome events only after that exposure')))).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Flag key')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Create feature flag' }));
    expect(screen.getByLabelText('Flag key')).toBeInTheDocument();
    expect(screen.getByText('Landing CTA example')).toBeInTheDocument();
  });

  it('wraps long experiment hypotheses inside a fixed responsive table', async () => {
    const hypothesis = 'Directional, non-causal test: among consented landing visitors, proof-first CTA copy should improve measured signup completion while retaining the same exposure grain.';
    mockedStore.mockReturnValue(store({
      flags: vi.fn().mockResolvedValue([]),
      experiments: vi.fn().mockResolvedValue([{
        id: 'experiment-1',
        key: 'proof_first_cta',
        name: 'Proof-first CTA',
        hypothesis,
        flag_key: 'landing_cta_copy',
        primary_metric_key: 'signup_completed',
        status: 'draft',
      }]),
      metrics: vi.fn().mockResolvedValue([metric]),
    }));
    render(<TooltipProvider><Experiments /></TooltipProvider>);
    const cell = (await screen.findByText(hypothesis)).closest('td');
    expect(cell).toHaveClass('whitespace-normal', 'break-words');
    expect(cell?.closest('table')).toHaveClass('table-fixed');
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
