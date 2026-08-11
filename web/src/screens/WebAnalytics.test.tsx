import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { Metric } from '../api/types';
import { useStore } from '../store';
import { WebAnalytics, hasAcceptedCanonicalPageViews, hasWebOutcome } from './WebAnalytics';

vi.mock('../store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../store')>()),
  useStore: vi.fn(),
}));

vi.mock('../analysis/charts', () => ({
  ManualVisualizationRenderer: () => <div data-testid="web-trend" />,
}));

const mockedStore = vi.mocked(useStore);

const metric = {
  id: 'web',
  key: 'web_page_views',
  name: 'Web page views',
  purpose: 'Count canonical browser page views over time.',
  category: 'acquisition',
  tags: ['browser-analytics'],
  type: 'count',
  source: { event: 'page.viewed' },
  status: 'active',
  owner: null,
  deprecation_reason: null,
  deprecated_at: null,
} as const;

const property = (key: string, enumValues: string[] | null = null) => ({
  id: `property-${key}`,
  key,
  scope: 'event' as const,
  value_type: key === '$route_key' ? 'enum' as const : 'string' as const,
  purpose: `Canonical purpose for ${key}.`,
  status: 'trusted' as const,
  source: 'native' as const,
  source_connection_id: null,
  enum_values: enumValues,
  created_by: 'test',
  created_at: '2026-07-01T00:00:00.000Z',
  updated_at: '2026-07-01T00:00:00.000Z',
});

const trustedProperties = [
  '$browser_context', '$page_view_id', '$device_class', '$browser_family', '$os_family',
  '$language', '$timezone', '$viewport_bucket', '$screen_bucket', '$country',
  '$utm_source', '$utm_medium', '$utm_campaign', '$utm_term', '$utm_content',
].map((key) => property(key));
trustedProperties.push(property('$route_key', ['home', 'pricing']));

describe('Web analytics partial availability', () => {
  const proposeBrowserAnalytics = vi.fn();
  const proposeAcquisitionProperties = vi.fn();
  const properties = vi.fn();
  const trend = vi.fn();
  const operationalQuery = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    proposeBrowserAnalytics.mockResolvedValue({ metrics: [metric], properties: [] });
    proposeAcquisitionProperties.mockResolvedValue([]);
    properties.mockResolvedValue(trustedProperties);
    trend.mockResolvedValue({
      kind: 'trend',
      series: [
        { bucket: '2026-07-31', value: 3, breakdown_value: 'launch' },
        { bucket: '2026-07-30', value: 2, breakdown_value: 'launch' },
        { bucket: '2026-07-31', value: 1, breakdown_value: 'retargeting' },
      ],
      meta: { computed_at: '2026-07-31T00:00:00.000Z', sampling: null },
    });
    operationalQuery.mockImplementation((_project, query) => {
      if (query.kind === 'web_analytics') {
        return Promise.resolve({
          kind: 'web_analytics',
          summary: {
            visitors: 8,
            sessions: 11,
            page_views: 20,
            average_session_duration_ms: null,
          },
          engagement: {
            measured_sessions: 9,
            incomplete_sessions: 2,
            unknown_sessions: 2,
            engaged_sessions: 6,
            bounce_sessions: 3,
            measured_session_coverage: 9 / 11,
            engaged_rate: 6 / 9,
            bounce_rate: 3 / 9,
            single_page_sessions: 7,
            timed_page_views: 18,
            total_page_views: 20,
            timed_page_coverage: 0.9,
            foreground_ms: 125_000,
            session_span_ms: 240_000,
          },
          breakdowns: {
            source: [{
              value: 'telegram',
              visitors: 6,
              sessions: 8,
              page_views: 15,
              percentage: 75,
            }],
            term: [{
              value: 'launch',
              visitors: 4,
              sessions: 4,
              page_views: 5,
              percentage: 25,
            }],
            device: [],
            browser: [],
          },
          meta: {
            computed_at: '2026-07-31T00:00:00.000Z',
            date_range: {
              from: '2026-07-01T00:00:00.000Z',
              to: '2026-07-31T00:00:00.000Z',
            },
            sampling: null,
            source: 'native',
            truncated_dimensions: [],
            unavailable_dimensions: {
              route: {
                code: 'safe_route_unavailable',
                reason: 'Route analysis requires a trusted route vocabulary.',
                next_action: 'Configure trusted route keys.',
              },
              campaign: {
                code: 'acquisition_property_untrusted',
                reason: 'Campaign attribution is not trusted yet.',
                next_action: 'Review the campaign property.',
              },
              medium: {
                code: 'acquisition_property_untrusted',
                reason: 'Medium attribution is not trusted yet.',
                next_action: 'Review the medium property.',
              },
              country: {
                code: 'web_analytics_dimension_unavailable',
                reason: 'Country enrichment is not active.',
                next_action: 'Keep country disabled until its server-side contract is reviewed.',
              },
            },
            definitions: {},
            accepted_event_accounting: 'Stored events remain unchanged.',
            privacy: 'Raw URLs are forbidden.',
          },
        });
      }
      if (query.kind === 'web_sessions') {
        return Promise.resolve({
          kind: 'web_sessions',
          sessions: [{
            session_id: 'session-1',
            actor_id: 'actor-1',
            started_at: '2026-07-31T00:00:00.000Z',
            ended_at: '2026-07-31T00:00:20.000Z',
            page_views: 2,
            timed_page_views: 2,
            foreground_ms: 15_000,
            session_span_ms: 20_000,
            engaged: true,
            bounce: false,
            single_page: false,
            complete: true,
          }],
          meta: {
            computed_at: '2026-07-31T00:00:21.000Z',
            date_range: {
              from: '2026-07-01T00:00:00.000Z',
              to: '2026-07-31T00:00:00.000Z',
            },
            sampling: null,
            source: 'native',
            total: 1,
            truncated: false,
            definitions: {},
          },
        });
      }
      throw new Error(`Unexpected query kind: ${query.kind}`);
    });
    mockedStore.mockReturnValue({
      project: 'y1blin-com',
      env: 'prod',
      client: {
        metrics: vi.fn().mockResolvedValue([metric]),
        properties,
        operationalQuery,
        query: vi.fn().mockResolvedValue({
          kind: 'trend',
          series: [],
          meta: {
            computed_at: '2026-07-31T00:00:00.000Z',
            date_range: {
              from: '2026-07-01T00:00:00.000Z',
              to: '2026-07-31T00:00:00.000Z',
            },
            sampling: null,
            source: 'native',
          },
        }),
        trend,
        proposeBrowserAnalytics,
        proposeAcquisitionProperties,
      },
    } as never);
  });

  it('keeps traffic, UTM source and sessions visible when routes are unavailable', async () => {
    render(
      <TooltipProvider>
        <MemoryRouter>
          <WebAnalytics />
        </MemoryRouter>
      </TooltipProvider>,
    );

    expect((await screen.findAllByText('Visitors')).length).toBeGreaterThan(0);
    expect(within(screen.getByText('resolved actors').parentElement!).getByText('8')).toBeInTheDocument();
    expect(within(screen.getByText('actor + session ID').parentElement!).getByText('11')).toBeInTheDocument();
    expect(within(screen.getByText('accepted canonical views').parentElement!).getByText('20')).toBeInTheDocument();
    expect(screen.getByText('telegram')).toBeInTheDocument();
    expect(operationalQuery.mock.calls.filter(([, query]) => query.kind === 'web_sessions')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Load recent sessions' }));
    await screen.findByRole('link', { name: 'actor-1' });
    const actorLink = screen.getByRole('link', { name: 'actor-1' });
    expect(actorLink).toHaveClass('text-foreground', 'hover:bg-muted');
    expect(actorLink).not.toHaveClass('text-primary');

    expect(screen.getByText(/Observed · Unavailable · 20 events ·/)).toBeInTheDocument();

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Pages' }), { button: 0, ctrlKey: false });

    expect(await screen.findByText('Pages unavailable')).toBeInTheDocument();
    expect(screen.getAllByText('Visitors').length).toBeGreaterThan(0);
    expect(screen.queryByText('telegram')).not.toBeInTheDocument();

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Countries' }), { button: 0, ctrlKey: false });
    expect(await screen.findByText('Countries unavailable')).toBeInTheDocument();

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Medium' }), { button: 0, ctrlKey: false });
    expect(await screen.findByText('Medium unavailable')).toBeInTheDocument();

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Conversions' }), { button: 0, ctrlKey: false });
    expect(screen.getByText('Choose a conversion to measure')).toBeInTheDocument();
    expect(screen.getByText(/will not display a zero/)).toBeInTheDocument();
  });

  it('does not keep prior-scope KPI data visible while a new project registry is loading', async () => {
    const view = render(
      <TooltipProvider><MemoryRouter><WebAnalytics /></MemoryRouter></TooltipProvider>,
    );

    await screen.findByText('telegram');
    mockedStore.mockReturnValue({
      project: 'beta',
      env: 'prod',
      client: {
        metrics: vi.fn(() => new Promise(() => undefined)),
        properties: vi.fn().mockResolvedValue(trustedProperties),
        operationalQuery,
        query: vi.fn(),
      },
    } as never);

    await act(async () => {
      view.rerender(<TooltipProvider><MemoryRouter><WebAnalytics /></MemoryRouter></TooltipProvider>);
    });

    expect(screen.getByLabelText('Loading web analytics')).toBeInTheDocument();
    expect(screen.queryByText('telegram')).not.toBeInTheDocument();
    expect(screen.queryByText('20')).not.toBeInTheDocument();
  });

  it('repairs legacy route and UTM definitions from Web', async () => {
    properties.mockResolvedValueOnce([]);
    render(
      <TooltipProvider><MemoryRouter><WebAnalytics /></MemoryRouter></TooltipProvider>,
    );

    expect(await screen.findByText('Finish web setup')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Safe route keys'), { target: { value: 'pricing, home' } });
    fireEvent.click(screen.getByRole('button', { name: 'Repair web tracking' }));

    await waitFor(() => expect(proposeBrowserAnalytics).toHaveBeenCalledWith('y1blin-com', ['home', 'pricing']));
    expect(await screen.findByText('Tracking definitions ready')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Review and activate' })).toHaveAttribute('href', '/registry');
  });

  it('shows trusted UTM term values from the canonical Web response', async () => {
    render(
      <TooltipProvider><MemoryRouter><WebAnalytics /></MemoryRouter></TooltipProvider>,
    );
    await screen.findByText('telegram');
    fireEvent.keyDown(screen.getByRole('tab', { name: 'UTM term' }), { key: 'Enter' });
    expect(await screen.findByText('launch')).toBeInTheDocument();
    expect(trend).not.toHaveBeenCalled();
    expect(screen.getByText('5')).toBeInTheDocument();
  });

  it('repairs a UTM-only gap without changing the trusted route vocabulary', async () => {
    properties.mockResolvedValueOnce(trustedProperties.filter((item) => item.key !== '$utm_term'));
    render(<TooltipProvider><MemoryRouter><WebAnalytics /></MemoryRouter></TooltipProvider>);

    expect(await screen.findByText('Finish web setup')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add UTM definitions' }));
    await waitFor(() => expect(proposeAcquisitionProperties).toHaveBeenCalledWith('y1blin-com'));
    expect(proposeBrowserAnalytics).not.toHaveBeenCalled();
  });

  it('creates the canonical website tracking plan without sending the user to Definitions first', async () => {
    const proposedMetric = { ...metric, status: 'proposed' as const };
    const metrics = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValue([proposedMetric]);
    const proposeBrowserAnalytics = vi.fn().mockResolvedValue({
      metrics: [proposedMetric],
      properties: [],
    });
    mockedStore.mockReturnValue({
      project: 'alpha',
      env: 'prod',
      client: { metrics, properties: vi.fn().mockResolvedValue([]), proposeBrowserAnalytics },
    } as never);

    render(
      <TooltipProvider>
        <MemoryRouter>
          <WebAnalytics />
        </MemoryRouter>
      </TooltipProvider>,
    );

    expect(await screen.findByText('Add website analytics')).toBeInTheDocument();
    expect(screen.getByText('Visitors')).toBeInTheDocument();
    expect(screen.getByText('Sessions')).toBeInTheDocument();
    expect(screen.getByText('Sources & UTM')).toBeInTheDocument();
    expect(screen.queryByText('Period')).not.toBeInTheDocument();
    const create = screen.getByRole('button', { name: 'Create web tracking plan' });
    expect(create).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Safe route keys'), {
      target: { value: 'pricing, home, pricing, docs.article' },
    });
    fireEvent.click(create);

    await waitFor(() => expect(proposeBrowserAnalytics).toHaveBeenCalledWith(
      'alpha',
      ['docs.article', 'home', 'pricing'],
    ));
    expect(await screen.findByText('Tracking plan ready')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Review and activate' })).toHaveAttribute('href', '/registry');
  });

  it('keeps acquisition secondary until canonical page views are activated', async () => {
    const acquisitionMetric = {
      ...metric,
      id: 'landing-visits',
      key: 'landing_visits',
      name: 'Landing visits',
      source: { event: 'landing.page_viewed' },
    };
    mockedStore.mockReturnValue({
      project: 'alpha',
      env: 'prod',
      client: {
        metrics: vi.fn().mockResolvedValue([acquisitionMetric]),
        properties: vi.fn().mockResolvedValue(trustedProperties),
        trend,
        proposeBrowserAnalytics,
      },
    } as never);

    render(<TooltipProvider><MemoryRouter><WebAnalytics /></MemoryRouter></TooltipProvider>);

    expect(await screen.findByText('Add website analytics')).toBeInTheDocument();
    expect(screen.getByText('Web setup order')).toBeInTheDocument();
    expect(screen.getByText('1. Canonical page views')).toBeInTheDocument();
    expect(screen.queryByText('Acquisition / UTM')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Run UTM report' })).not.toBeInTheDocument();
  });
});

describe('Web setup readiness', () => {
  it('requires accepted page views in the selected period for canonical readiness', () => {
    expect(hasAcceptedCanonicalPageViews(0)).toBe(false);
    expect(hasAcceptedCanonicalPageViews(1)).toBe(true);
  });

  it('requires an active outcome explicitly mapped to the web surface', () => {
    const canonical = { ...metric, tags: [...metric.tags] } satisfies Metric;
    const unrelated = { ...canonical, id: 'revenue', key: 'revenue', type: 'value' as const, tags: ['surface:bot'] } satisfies Metric;
    const webOutcome = { ...unrelated, tags: ['surface:web'] } satisfies Metric;
    const webConversion = { ...webOutcome, type: 'conversion' as const } satisfies Metric;

    expect(hasWebOutcome([canonical, unrelated])).toBe(false);
    expect(hasWebOutcome([canonical, webOutcome])).toBe(true);
    expect(hasWebOutcome([canonical, webConversion])).toBe(true);
  });
});
