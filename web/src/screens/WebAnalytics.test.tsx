import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { Metric } from '../api/types';
import { useStore } from '../store';
import { WebAnalytics, hasAcceptedCanonicalPageViews, hasWebOutcome, previousExactRange, webConversionMetric, webOutcomeMetric } from './WebAnalytics';

vi.mock('../store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../store')>()),
  useStore: vi.fn(),
}));

vi.mock('../analysis/charts', () => ({
  ManualVisualizationRenderer: () => <div data-testid="web-trend" />,
}));

const mockedStore = vi.mocked(useStore);
const routerFuture = { v7_startTransition: true, v7_relativeSplatPath: true } as const;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

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
const webOutcome = {
  ...metric,
  id: 'signup-completed',
  key: 'signup_completed',
  name: 'Signup completed',
  purpose: 'Count completed signup outcomes attributed only by explicit product evidence.',
  tags: ['surface:web'],
  source: { event: 'signup.completed' },
} as const;
const webConversion = {
  ...webOutcome,
  id: 'web-signup-conversion',
  key: 'web_signup_conversion',
  name: 'Visit to signup',
  purpose: 'Measures whether a website visit reaches a completed signup within one hour.',
  tags: ['surface:web'],
  type: 'conversion',
  source: {
    from: { event: 'page.viewed', filters: [] },
    to: { event: 'signup.completed', filters: [] },
    window_seconds: 3600,
  },
} satisfies Metric;

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

  it('anchors the previous exact period to the returned current date range', () => {
    expect(previousExactRange({
      from: '2026-07-01T00:00:00.000Z',
      to: '2026-07-31T00:00:00.000Z',
    })).toEqual({
      from: '2026-06-01T00:00:00.000Z',
      to: '2026-07-01T00:00:00.000Z',
    });
    expect(previousExactRange({ from: 'invalid', to: '2026-07-31T00:00:00.000Z' })).toBeNull();
  });

  it('uses the shared custom period and loads the default traffic breakdown without an extra gate', async () => {
    render(
      <TooltipProvider>
        <MemoryRouter future={routerFuture}>
          <WebAnalytics />
        </MemoryRouter>
      </TooltipProvider>,
    );

    expect(await screen.findByRole('heading', { name: 'Web' })).toBeInTheDocument();
    const period = screen.getByRole('group', { name: 'Analytics period' });
    expect(await screen.findByText('telegram')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load traffic breakdown' })).not.toBeInTheDocument();

    fireEvent.click(within(period).getByRole('button', { name: 'Custom' }));
    fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '2026-08-01' } });
    fireEvent.change(screen.getByLabelText('End date'), { target: { value: '2026-08-02' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply period' }));

    await waitFor(() => expect(operationalQuery).toHaveBeenCalledWith('y1blin-com', expect.objectContaining({
      kind: 'web_analytics',
      date_from: '2026-08-01T00:00:00.000Z',
      date_to: '2026-08-03T00:00:00.000Z',
    })));
    expect(screen.queryByRole('combobox', { name: 'Acquisition period' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Run UTM report' }));
    await waitFor(() => expect(trend).toHaveBeenCalledWith('y1blin-com', expect.objectContaining({
      date_from: '2026-08-01T00:00:00.000Z',
      date_to: '2026-08-03T00:00:00.000Z',
      breakdown: { property: '$utm_source' },
    })));
  });

  it('keeps traffic, UTM source and sessions visible when routes are unavailable', async () => {
    render(
      <TooltipProvider>
        <MemoryRouter future={routerFuture}>
          <WebAnalytics />
        </MemoryRouter>
      </TooltipProvider>,
    );

    expect((await screen.findAllByText('Visitors')).length).toBeGreaterThan(0);
    expect(within(screen.getByText('resolved actors').parentElement!).getByText('8')).toBeInTheDocument();
    expect(within(screen.getByText('actor + session ID').parentElement!).getByText('11')).toBeInTheDocument();
    expect(within(screen.getByText('accepted canonical views').parentElement!).getByText('20')).toBeInTheDocument();
    expect(await screen.findByText('telegram')).toBeInTheDocument();
    expect(operationalQuery.mock.calls.filter(([, query]) => query.kind === 'web_sessions')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Load recent sessions' }));
    await screen.findByRole('link', { name: 'actor-1' });
    const actorLink = screen.getByRole('link', { name: 'actor-1' });
    expect(actorLink).toHaveClass('text-foreground', 'hover:bg-muted');
    expect(actorLink).not.toHaveClass('text-primary');

    expect(screen.getByText(/Observed · Unavailable · 20 events ·/)).toBeInTheDocument();

    await act(async () => {
      fireEvent.mouseDown(screen.getByRole('tab', { name: 'Pages' }), { button: 0, ctrlKey: false });
    });

    expect(await screen.findByText('Pages unavailable')).toBeInTheDocument();
    expect(screen.getAllByText('Visitors').length).toBeGreaterThan(0);
    expect(screen.queryByText('telegram')).not.toBeInTheDocument();

    await act(async () => {
      fireEvent.mouseDown(screen.getByRole('tab', { name: 'Countries' }), { button: 0, ctrlKey: false });
    });
    expect(await screen.findByText('Countries unavailable')).toBeInTheDocument();

    await act(async () => {
      fireEvent.mouseDown(screen.getByRole('tab', { name: 'Medium' }), { button: 0, ctrlKey: false });
    });
    expect(await screen.findByText('Medium unavailable')).toBeInTheDocument();

    await act(async () => {
      fireEvent.mouseDown(screen.getByRole('tab', { name: 'Conversions' }), { button: 0, ctrlKey: false });
    });
    expect(await screen.findByText('Choose a conversion to measure')).toBeInTheDocument();
    expect(screen.getByText(/will not display a zero/)).toBeInTheDocument();
  });

  it('leads a ready Web workspace with a trusted answer and previous-period delta before the chart', async () => {
    let outcomeReads = 0;
    const query = vi.fn().mockImplementation((_project, input) => {
      if (input.metric !== webOutcome.key) {
        return Promise.resolve({ kind: 'trend', series: [], meta: { computed_at: '2026-07-31T00:00:00.000Z', sampling: null } });
      }
      const value = outcomeReads++ === 0 ? 12 : 8;
      return Promise.resolve({
        kind: 'trend',
        series: [{ bucket: input.date_to ?? '2026-07-31', value }],
        answer: {
          state: 'ready', headline: `${webOutcome.name}: ${value}`, takeaway: `${value} matched.`,
          primary_value: { value, unit: 'count', formatted: String(value) },
          why_it_matters: webOutcome.purpose,
        },
        evidence: {
          state: 'trusted', as_of: '2026-07-31T00:00:00.000Z', freshness: 'fresh',
          source_refs: [{ kind: 'metric', key: webOutcome.key, purpose: webOutcome.purpose }],
          aggregation: 'count of accepted events', warnings: [], unavailable_reasons: [],
        },
        meta: {
          computed_at: outcomeReads === 1 ? '2026-07-31T00:00:00.000Z' : '2026-07-31T00:00:01.000Z',
          date_range: { from: input.date_from, to: input.date_to },
          sampling: null,
        },
      });
    });
    mockedStore.mockReturnValue({
      project: 'y1blin-com',
      env: 'prod',
      client: {
        metrics: vi.fn().mockResolvedValue([metric, webOutcome]),
        properties,
        operationalQuery,
        query,
        measurementTrust: vi.fn().mockResolvedValue({ status: 'trusted', primary_metric: { observed_events: 20 }, blockers: [], warnings: [] }),
      },
    } as never);

    render(<TooltipProvider><MemoryRouter future={routerFuture}><WebAnalytics /></MemoryRouter></TooltipProvider>);

    const answer = await screen.findByRole('heading', { name: 'Web health' });
    expect(screen.getByText('20 canonical page views across 11 sessions')).toBeInTheDocument();
    expect(await screen.findByText('No change versus the previous 30 days.')).toBeInTheDocument();
    expect(await screen.findByText(/Trusted measurement/)).toBeInTheDocument();
    expect(await screen.findByText('Signup completed: 12')).toBeInTheDocument();
    expect(await screen.findByText('Up 50.0% versus the previous 30 days.')).toBeInTheDocument();
    const outcomeEvidence = screen.getByText(/count of accepted events/);
    expect(outcomeEvidence).not.toBeVisible();
    fireEvent.click(screen.getByLabelText('About web outcome evidence'));
    expect(outcomeEvidence).toBeVisible();
    const outcomeCalls = query.mock.calls.filter(([, input]) => input.metric === webOutcome.key);
    expect(outcomeCalls).toHaveLength(2);
    expect(outcomeCalls[0]?.[1]).toEqual(expect.objectContaining({ env: 'prod' }));
    expect(outcomeCalls[1]?.[1].date_to).toBe(outcomeCalls[0]?.[1].date_from);
    expect(Date.parse(outcomeCalls[0]?.[1].date_to) - Date.parse(outcomeCalls[0]?.[1].date_from)).toBe(
      Date.parse(outcomeCalls[1]?.[1].date_to) - Date.parse(outcomeCalls[1]?.[1].date_from),
    );
    const chart = await screen.findByTestId('web-trend');
    expect(chart.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const trafficCalls = operationalQuery.mock.calls.filter(([, input]) => input.kind === 'web_analytics' && input.dimensions?.length === 0);
    expect(trafficCalls).toHaveLength(2);
    expect(trafficCalls[1]?.[1].date_to).toBe(trafficCalls[0]?.[1].date_from);
  });

  it('keeps traffic readable and never turns an unavailable outcome query into zero', async () => {
    const query = vi.fn((_project, input) => input.metric === webOutcome.key
      ? Promise.reject(new Error('outcome source unavailable'))
      : Promise.resolve({ kind: 'trend', series: [], meta: { computed_at: '2026-07-31T00:00:00.000Z', sampling: null } }));
    mockedStore.mockReturnValue({
      project: 'y1blin-com', env: 'prod',
      client: {
        metrics: vi.fn().mockResolvedValue([metric, webOutcome]), properties, operationalQuery, query,
        measurementTrust: vi.fn().mockResolvedValue({ status: 'trusted', primary_metric: { observed_events: 20 }, blockers: [], warnings: [] }),
      },
    } as never);

    render(<TooltipProvider><MemoryRouter future={routerFuture}><WebAnalytics /></MemoryRouter></TooltipProvider>);

    expect(await screen.findByText('20 canonical page views across 11 sessions')).toBeInTheDocument();
    expect(await screen.findByText(/could not be measured for this exact period/)).toBeInTheDocument();
    expect(screen.getByText('outcome source unavailable')).toBeInTheDocument();
    expect(screen.queryByText('Signup completed: 0')).not.toBeInTheDocument();
  });

  it('runs the active web conversion against the exact Web result period and renders measured evidence', async () => {
    const query = vi.fn((_project, input) => {
      if (input.kind === 'trend') {
        return Promise.resolve({
          kind: 'trend', series: [],
          meta: {
            computed_at: '2026-07-31T00:00:00.000Z',
            date_range: { from: '2026-07-01T00:00:00.000Z', to: '2026-07-31T00:00:00.000Z' },
            sampling: null, source: 'native',
          },
        });
      }
      if (input.kind === 'funnel') {
        return Promise.resolve({
          kind: 'funnel',
          steps: [
            { label: 'Entered Visit to signup', metric_key: webConversion.key, purpose: webConversion.purpose, category: null, actors: 8, conversion_from_prev: 1, conversion_from_start: 1 },
            { label: 'Reached Visit to signup', metric_key: webConversion.key, purpose: webConversion.purpose, category: null, actors: 3, conversion_from_prev: 0.375, conversion_from_start: 0.375 },
          ],
          summary: {
            overall_conversion: 0.375,
            previous_overall_conversion: 0.25,
            delta_percentage_points: 12.5,
            biggest_absolute_loss: { from_step: 0, to_step: 1, lost_actors: 5, drop_rate: 0.625 },
            biggest_percentage_loss: { from_step: 0, to_step: 1, lost_actors: 5, drop_rate: 0.625 },
          },
          answer: {
            state: 'ready', headline: '37.5% reached Visit to signup',
            takeaway: '3 of 8 actors reached the final step.',
            primary_value: { value: 37.5, unit: 'percent', formatted: '37.5%' },
            delta: { value: 12.5, unit: 'percentage_point', direction: 'up', comparison_label: 'previous exact period' },
            why_it_matters: webConversion.purpose,
          },
          evidence: {
            state: 'trusted', as_of: '2026-07-31T00:00:00.000Z', freshness: 'fresh',
            source_refs: [{ kind: 'metric', key: webConversion.key, purpose: webConversion.purpose }],
            aggregation: 'ordered unique actors within the registered conversion window',
            denominator: { label: `actors who entered ${webConversion.key}`, value: 8 },
            sample: { eligible: 8, observed: 3, coverage: 0.375 },
            warnings: [], unavailable_reasons: [], reproducible_query: input,
          },
          meta: {
            computed_at: '2026-07-31T00:00:00.000Z',
            date_range: { from: '2026-07-01T00:00:00.000Z', to: '2026-07-31T00:00:00.000Z' },
            sampling: null, source: 'native',
          },
        });
      }
      throw new Error(`Unexpected query kind: ${input.kind}`);
    });
    mockedStore.mockReturnValue({
      project: 'y1blin-com', env: 'prod',
      client: {
        metrics: vi.fn().mockResolvedValue([metric, webConversion]), properties, operationalQuery, query,
        measurementTrust: vi.fn().mockResolvedValue({ status: 'trusted', primary_metric: { observed_events: 20 }, blockers: [], warnings: [] }),
      },
    } as never);

    render(<TooltipProvider><MemoryRouter future={routerFuture}><WebAnalytics /></MemoryRouter></TooltipProvider>);
    fireEvent.mouseDown(await screen.findByRole('tab', { name: 'Conversions' }), { button: 0, ctrlKey: false });

    expect(await screen.findByRole('heading', { name: 'Visit to signup' })).toBeInTheDocument();
    expect(screen.getAllByText('37.5%')).toHaveLength(2);
    expect(screen.getByText('+12.5 pp versus previous exact period')).toBeInTheDocument();
    expect(screen.getByText('3 of 8 actors converted')).toBeInTheDocument();
    const conversionEvidence = screen.getByText(/Exact UTC window: \[2026-07-01T00:00:00.000Z, 2026-07-31T00:00:00.000Z\)/);
    expect(conversionEvidence).not.toBeVisible();
    fireEvent.click(screen.getByLabelText('About conversion evidence'));
    expect(conversionEvidence).toBeVisible();
    expect(query).toHaveBeenCalledWith('y1blin-com', {
      kind: 'funnel',
      conversion_metric: 'web_signup_conversion',
      date_from: '2026-07-01T00:00:00.000Z',
      date_to: '2026-07-31T00:00:00.000Z',
      env: 'prod',
    });
  });

  it('reruns conversion for an exact range change with the same computed_at and ignores the stale response', async () => {
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });
    const sameComputedAt = '2026-08-01T00:00:00.000Z';
    const thirtyDayRange = {
      from: '2026-07-01T00:00:00.000Z',
      to: '2026-07-31T00:00:00.000Z',
    };
    const sevenDayRange = {
      from: '2026-07-24T00:00:00.000Z',
      to: '2026-07-31T00:00:00.000Z',
    };
    const thirtyDayConversion = deferred<ReturnType<typeof conversionResult>>();
    const sevenDayConversion = deferred<ReturnType<typeof conversionResult>>();
    const scopedOperationalQuery = vi.fn(async (project, input) => {
      const result = await operationalQuery(project, input);
      if (input.kind !== 'web_analytics') return result;
      const exactRange = input.date_from === sevenDayRange.from ? sevenDayRange : thirtyDayRange;
      return {
        ...result,
        meta: { ...result.meta, computed_at: sameComputedAt, date_range: exactRange },
      };
    });
    const query = vi.fn((_project, input) => {
      if (input.kind === 'trend') {
        return Promise.resolve({
          kind: 'trend', series: [],
          meta: {
            computed_at: sameComputedAt,
            date_range: thirtyDayRange,
            sampling: null,
            source: 'native',
          },
        });
      }
      if (input.kind === 'funnel') {
        return input.date_from === sevenDayRange.from
          ? sevenDayConversion.promise
          : thirtyDayConversion.promise;
      }
      throw new Error(`Unexpected query kind: ${input.kind}`);
    });
    mockedStore.mockReturnValue({
      project: 'y1blin-com', env: 'prod',
      client: {
        metrics: vi.fn().mockResolvedValue([metric, webConversion]),
        properties,
        operationalQuery: scopedOperationalQuery,
        query,
      },
    } as never);

    render(<TooltipProvider><MemoryRouter future={routerFuture}><WebAnalytics /></MemoryRouter></TooltipProvider>);
    fireEvent.mouseDown(await screen.findByRole('tab', { name: 'Conversions' }), { button: 0, ctrlKey: false });
    await waitFor(() => expect(query).toHaveBeenCalledWith('y1blin-com', expect.objectContaining({
      kind: 'funnel',
      date_from: thirtyDayRange.from,
      date_to: thirtyDayRange.to,
    })));

    const period = screen.getByRole('group', { name: 'Analytics period' });
    fireEvent.click(within(period).getByRole('button', { name: 'Custom' }));
    fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '2026-07-24' } });
    fireEvent.change(screen.getByLabelText('End date'), { target: { value: '2026-07-30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply period' }));
    await waitFor(() => expect(query).toHaveBeenCalledWith('y1blin-com', expect.objectContaining({
      kind: 'funnel',
      date_from: sevenDayRange.from,
      date_to: sevenDayRange.to,
    })));

    await act(async () => {
      sevenDayConversion.resolve(conversionResult(sevenDayRange, 8, 4));
    });
    expect(await screen.findAllByText('50.0%')).toHaveLength(2);

    await act(async () => {
      thirtyDayConversion.resolve(conversionResult(thirtyDayRange, 10, 1));
    });
    expect(screen.getAllByText('50.0%')).toHaveLength(2);
    expect(screen.queryByText('10.0%')).not.toBeInTheDocument();
    expect(query.mock.calls.filter(([, input]) => input.kind === 'funnel').map(([, input]) => ({
      from: input.date_from,
      to: input.date_to,
    }))).toEqual(expect.arrayContaining([thirtyDayRange, sevenDayRange]));
  });

  it('does not turn a missing conversion denominator into zero percent', async () => {
    const query = vi.fn((_project, input) => input.kind === 'trend'
      ? Promise.resolve({ kind: 'trend', series: [], meta: { computed_at: '2026-07-31T00:00:00.000Z', sampling: null, source: 'native' } })
      : Promise.resolve({
        kind: 'funnel',
        steps: [
          { label: 'Entered Visit to signup', metric_key: webConversion.key, purpose: webConversion.purpose, category: null, actors: 0, conversion_from_prev: 1, conversion_from_start: 1 },
          { label: 'Reached Visit to signup', metric_key: webConversion.key, purpose: webConversion.purpose, category: null, actors: 0, conversion_from_prev: null, conversion_from_start: null },
        ],
        summary: { overall_conversion: null, previous_overall_conversion: null, delta_percentage_points: null, biggest_absolute_loss: null, biggest_percentage_loss: null },
        answer: { state: 'empty', headline: 'No actors entered this funnel', takeaway: 'The selected window has no measured funnel denominator.', why_it_matters: webConversion.purpose },
        evidence: {
          state: 'partial', as_of: '2026-07-31T00:00:00.000Z', freshness: 'fresh',
          source_refs: [{ kind: 'metric', key: webConversion.key, purpose: webConversion.purpose }],
          aggregation: 'ordered unique actors within the registered conversion window',
          denominator: { label: `actors who entered ${webConversion.key}`, value: null },
          sample: { eligible: null, observed: null, coverage: null }, warnings: [],
          unavailable_reasons: [{ code: 'missing_denominator', message: 'No actors reached the first step.' }],
          reproducible_query: input,
        },
        meta: {
          computed_at: '2026-07-31T00:00:00.000Z',
          date_range: { from: '2026-07-01T00:00:00.000Z', to: '2026-07-31T00:00:00.000Z' },
          sampling: null, source: 'native',
        },
      }));
    mockedStore.mockReturnValue({
      project: 'y1blin-com', env: 'prod',
      client: { metrics: vi.fn().mockResolvedValue([metric, webConversion]), properties, operationalQuery, query },
    } as never);

    render(<TooltipProvider><MemoryRouter future={routerFuture}><WebAnalytics /></MemoryRouter></TooltipProvider>);
    fireEvent.mouseDown(await screen.findByRole('tab', { name: 'Conversions' }), { button: 0, ctrlKey: false });

    expect(await screen.findByText('No measured denominator')).toBeInTheDocument();
    expect(screen.getByText('Conversion rate is unavailable; no actor reached the registered start source in this period.')).toBeInTheDocument();
    expect(screen.queryByText('0%')).not.toBeInTheDocument();
  });

  it('keeps the current Web health answer when the previous-period comparison is unavailable', async () => {
    let primaryReads = 0;
    const partialOperationalQuery = vi.fn((project, query) => {
      if (query.kind === 'web_analytics' && query.dimensions?.length === 0 && primaryReads++ === 1) return Promise.reject(new Error('previous unavailable'));
      return operationalQuery(project, query);
    });
    mockedStore.mockReturnValue({
      project: 'y1blin-com', env: 'prod',
      client: {
        metrics: vi.fn().mockResolvedValue([metric, webOutcome]), properties,
        operationalQuery: partialOperationalQuery,
        query: vi.fn().mockResolvedValue({ kind: 'trend', series: [], meta: { computed_at: '2026-07-31T00:00:00.000Z', sampling: null } }),
        measurementTrust: vi.fn().mockResolvedValue({ status: 'trusted', primary_metric: { observed_events: 20 }, blockers: [], warnings: [] }),
      },
    } as never);

    render(<TooltipProvider><MemoryRouter future={routerFuture}><WebAnalytics /></MemoryRouter></TooltipProvider>);

    expect(await screen.findByText('20 canonical page views across 11 sessions')).toBeInTheDocument();
    expect(await screen.findByText('Previous-period comparison is unavailable.')).toBeInTheDocument();
    expect(await screen.findByTestId('web-trend')).toBeInTheDocument();
  });

  it('renders the current headline while automatic secondary reads stay slow', async () => {
    const overview = await operationalQuery('y1blin-com', {
      kind: 'web_analytics',
      metric: metric.key,
      date_from: '-30d',
      filters: [],
      env: 'prod',
      dimensions: [],
    });
    operationalQuery.mockClear();
    let primaryReads = 0;
    const isolatedOperationalQuery = vi.fn((_project, query) => {
      if (query.kind === 'web_analytics' && query.dimensions?.includes('source')) return new Promise(() => undefined);
      if (query.kind === 'web_analytics' && query.dimensions?.length === 0) {
        return primaryReads++ === 0 ? Promise.resolve(overview) : new Promise(() => undefined);
      }
      if (query.kind === 'web_analytics') return Promise.resolve(overview);
      throw new Error(`Unexpected query kind: ${query.kind}`);
    });
    const slowTrend = vi.fn(() => new Promise(() => undefined));
    const slowTrust = vi.fn(() => new Promise(() => undefined));
    const slowReadiness = vi.fn(() => new Promise(() => undefined));
    mockedStore.mockReturnValue({
      project: 'y1blin-com',
      env: 'prod',
      client: {
        metrics: vi.fn().mockResolvedValue([metric, webOutcome]),
        properties,
        operationalQuery: isolatedOperationalQuery,
        query: slowTrend,
        measurementTrust: slowTrust,
        measurementReadiness: slowReadiness,
      },
    } as never);

    render(<TooltipProvider><MemoryRouter future={routerFuture}><WebAnalytics /></MemoryRouter></TooltipProvider>);

    expect(await screen.findByText('20 canonical page views across 11 sessions')).toBeInTheDocument();
    expect(screen.getByText('Previous-period comparison is loading.')).toBeInTheDocument();
    expect(isolatedOperationalQuery.mock.calls.filter(([, query]) => query.dimensions?.includes('source'))).toHaveLength(1);
    expect(screen.queryByText('telegram')).not.toBeInTheDocument();
    expect(screen.getByText('Loading Sources breakdown…')).toBeInTheDocument();
    expect(screen.getByText('20 canonical page views across 11 sessions')).toBeInTheDocument();
  });

  it('does not keep prior-scope KPI data visible while a new project registry is loading', async () => {
    const view = render(
      <TooltipProvider><MemoryRouter future={routerFuture}><WebAnalytics /></MemoryRouter></TooltipProvider>,
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
      view.rerender(<TooltipProvider><MemoryRouter future={routerFuture}><WebAnalytics /></MemoryRouter></TooltipProvider>);
    });

    expect(screen.getByLabelText('Loading web analytics')).toBeInTheDocument();
    expect(screen.queryByText('telegram')).not.toBeInTheDocument();
    expect(screen.queryByText('20')).not.toBeInTheDocument();
  });

  it('repairs legacy route and UTM definitions from Web', async () => {
    properties.mockResolvedValueOnce([]);
    render(
      <TooltipProvider><MemoryRouter future={routerFuture}><WebAnalytics /></MemoryRouter></TooltipProvider>,
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
      <TooltipProvider><MemoryRouter future={routerFuture}><WebAnalytics /></MemoryRouter></TooltipProvider>,
    );
    fireEvent.keyDown(await screen.findByRole('tab', { name: 'UTM term' }), { key: 'Enter' });
    expect(await screen.findByText('launch')).toBeInTheDocument();
    expect(trend).not.toHaveBeenCalled();
    expect(screen.getByText('5')).toBeInTheDocument();
  });

  it('repairs a UTM-only gap without changing the trusted route vocabulary', async () => {
    properties.mockResolvedValueOnce(trustedProperties.filter((item) => item.key !== '$utm_term'));
    render(<TooltipProvider><MemoryRouter future={routerFuture}><WebAnalytics /></MemoryRouter></TooltipProvider>);

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
        <MemoryRouter future={routerFuture}>
          <WebAnalytics />
        </MemoryRouter>
      </TooltipProvider>,
    );

    expect(await screen.findByText('Add website analytics')).toBeInTheDocument();
    expect(screen.getByText('Visitors')).toBeInTheDocument();
    expect(screen.getByText('Sessions')).toBeInTheDocument();
    expect(screen.getByText('Sources & UTM')).toBeInTheDocument();
    expect(screen.getAllByText('—')).toHaveLength(4);
    expect(screen.queryByText('Waiting for setup')).not.toBeInTheDocument();
    const routeHelp = screen.getByText(/Use stable names such as/);
    expect(routeHelp).not.toBeVisible();
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

    render(<TooltipProvider><MemoryRouter future={routerFuture}><WebAnalytics /></MemoryRouter></TooltipProvider>);

    expect(await screen.findByText('Add website analytics')).toBeInTheDocument();
    const setupOrder = screen.getByText('Setup order');
    expect(setupOrder.closest('details')).not.toHaveAttribute('open');
    expect(screen.getByText('1. Canonical page views')).toBeInTheDocument();
    expect(screen.queryByText('Acquisition / UTM')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Run UTM report' })).not.toBeInTheDocument();
  });

  it('links missing web definitions to the exact affected saved answer', async () => {
    mockedStore.mockReturnValue({
      project: 'alpha',
      env: 'prod',
      client: {
        metrics: vi.fn().mockResolvedValue([]),
        properties: vi.fn().mockResolvedValue([]),
        measurementReadiness: vi.fn().mockResolvedValue({
          groups: [{
            key: 'properties',
            gaps: [{ definition_ref: '$utm_source', affected_answer_ids: ['answer-web-conversion'] }],
          }],
        }),
      },
    } as never);

    render(<TooltipProvider><MemoryRouter future={routerFuture}><WebAnalytics /></MemoryRouter></TooltipProvider>);

    expect(await screen.findByRole('link', { name: 'answer-web-conversion' })).toHaveAttribute(
      'href',
      '/analyze/saved?answer=answer-web-conversion',
    );
  });
});

function conversionResult(
  range: { from: string; to: string },
  entered: number,
  converted: number,
) {
  const conversion = converted / entered;
  return {
    kind: 'funnel' as const,
    steps: [
      {
        label: 'Entered Visit to signup', metric_key: webConversion.key,
        purpose: webConversion.purpose, category: null, actors: entered,
        conversion_from_prev: 1, conversion_from_start: 1,
      },
      {
        label: 'Reached Visit to signup', metric_key: webConversion.key,
        purpose: webConversion.purpose, category: null, actors: converted,
        conversion_from_prev: conversion, conversion_from_start: conversion,
      },
    ],
    summary: {
      overall_conversion: conversion,
      previous_overall_conversion: null,
      delta_percentage_points: null,
      biggest_absolute_loss: null,
      biggest_percentage_loss: null,
    },
    evidence: {
      state: 'trusted' as const,
      aggregation: 'ordered unique actors within the registered conversion window',
    },
    meta: {
      computed_at: '2026-08-01T00:00:00.000Z',
      date_range: range,
      sampling: null,
      source: 'native' as const,
    },
  };
}

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
    expect(webOutcomeMetric([canonical, webConversion, webOutcome])?.key).toBe(webOutcome.key);
  });

  it('selects one active native web conversion deterministically', () => {
    const later = { ...webConversion, id: 'z', key: 'z_conversion' } satisfies Metric;
    const earlier = { ...webConversion, id: 'a', key: 'a_conversion' } satisfies Metric;
    const proposed = { ...webConversion, id: 'p', key: 'proposed_conversion', status: 'proposed' as const } satisfies Metric;

    expect(webConversionMetric([later, proposed, earlier])?.key).toBe('a_conversion');
    expect(webConversionMetric([{ ...earlier, tags: ['surface:bot'] }])).toBeNull();
  });
});
