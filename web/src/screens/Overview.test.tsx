import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../store';
import { Overview } from './Overview';

const { telemetryCapture } = vi.hoisted(() => ({ telemetryCapture: vi.fn() }));

vi.mock('../store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../store')>()),
  useStore: vi.fn(),
}));

vi.mock('../productTelemetry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../productTelemetry')>()),
  captureProductTelemetry: telemetryCapture,
}));

vi.mock('../analysis/charts', () => ({
  TrendChart: ({ label }: { label: string }) => <div role="img" aria-label={label}><span>Day 1: 4</span><span>Day 2: 6</span></div>,
}));

const mockedStore = vi.mocked(useStore);
const webMetric = {
  id: 'web', key: 'web_page_views', name: 'Web page views', purpose: 'Count accepted canonical browser page views.',
  category: 'acquisition', tags: [], type: 'count', source: { event: 'page.viewed' }, status: 'active',
  owner: null, deprecation_reason: null, deprecated_at: null,
} as const;

const productMetric = {
  ...webMetric,
  id: 'active', key: 'weekly_active_users', name: 'Weekly active users',
  purpose: 'Count people who reach a meaningful product outcome.', category: 'activation', type: 'unique_actors',
  source: { event: 'product.used' },
} as const;

function controlTowerResponse() {
  return {
    schema_version: 1,
    request_id: 'control-request',
    generated_at: '2026-08-06T00:00:00.000Z',
    home_answer_surface: 'website',
    home_metric_key: 'web_page_views',
    home_funnel_key: null,
    scope: {
      project_slug: 'alpha',
      environment: 'prod',
      window: { from: '2026-07-07T00:00:00.000Z', to: '2026-08-06T00:00:00.000Z', timezone: 'UTC' },
    },
    answer: {
      state: 'partial',
      headline: '1 item needs attention',
      takeaway: 'The server found a measurement blocker.',
      primary_value: { value: 1, unit: 'count', formatted: '1' },
      why_it_matters: 'Server ordering must be identical in REST, MCP, and the UI.',
    },
    attention: [{
      id: 'server.measurement.blocked',
      rule_id: 'server.measurement.blocked',
      rule_version: 3,
      severity: 'high',
      state: 'open',
      title: 'Server-ordered measurement blocker',
      reason: 'This item exists only in the canonical control-tower response.',
      impact: 'The primary outcome cannot be trusted until the blocker is reviewed.',
      affected: [{ kind: 'metric', ref: 'web_page_views' }],
      evidence: {
        state: 'blocked',
        as_of: '2026-08-06T00:00:00.000Z',
        freshness: 'fresh',
        source_refs: [{ kind: 'operator_rule', rule_id: 'server.measurement.blocked', rule_version: 3 }],
        warnings: [],
        unavailable_reasons: [],
      },
      primary_action: { id: 'review_definition', kind: 'navigate', label: 'Review definition', href: '/registry' },
    }],
    evidence: {
      state: 'blocked',
      as_of: '2026-08-06T00:00:00.000Z',
      freshness: 'fresh',
      source_refs: [{ kind: 'operator_rule', rule_id: 'server.measurement.blocked', rule_version: 3 }],
      warnings: [],
      unavailable_reasons: [],
    },
    primary_action: { id: 'review_definition', kind: 'navigate', label: 'Review definition', href: '/registry' },
    secondary_actions: [],
  };
}

function websiteClient(intent: 'website' | 'both' | null = 'website', activeLinks = 0) {
  return {
    controlTower: vi.fn().mockResolvedValue(controlTowerResponse()),
    projectIntent: vi.fn().mockResolvedValue({ intent: intent ? { project_mode: intent, goal_ids: ['website_traffic'], primary_goal_id: 'website_traffic' } : null }),
    metrics: vi.fn().mockResolvedValue([webMetric]),
    funnels: vi.fn().mockResolvedValue([]),
    onboardingStatus: vi.fn().mockResolvedValue({ complete: true, gates: [], next_blocker: null, final_result: null }),
    schema: vi.fn().mockResolvedValue({ identity: { active_links: activeLinks } }),
    operationalQuery: vi.fn().mockResolvedValue({
      kind: 'web_analytics',
      summary: { visitors: 8, sessions: 10, page_views: 20, average_session_duration_ms: null },
      engagement: {},
      breakdowns: {
        source: [{ value: 'organic', visitors: 6, sessions: 7, page_views: 14, percentage: 70 }],
        route: [{ value: 'home', visitors: 8, sessions: 10, page_views: 20, percentage: 100 }],
      },
      meta: { unavailable_dimensions: {}, truncated_dimensions: [], date_range: {}, computed_at: '2026-08-06T00:00:00Z' },
    }),
    query: vi.fn().mockResolvedValue({
      kind: 'trend', series: [{ bucket: '2026-08-05T00:00:00Z', value: 20 }],
      meta: { computed_at: '2026-08-06T00:00:00Z', date_range: { from: '2026-07-07T00:00:00Z', to: '2026-08-06T00:00:00Z' }, sampling: null, source: 'native' },
    }),
    measurementTrust: vi.fn().mockResolvedValue({
      status: 'trusted',
      primary_metric: { key: webMetric.key, purpose: webMetric.purpose, category: 'acquisition', observed_events: 20, observed_actors: 8, registered_coverage: 1 },
      identity: { distinct_id_coverage: 1, raw_actors: 8, resolved_actors: 8 }, properties: [], blockers: [], warnings: [],
    }),
  };
}

function setStore(client: Record<string, unknown>, project = 'alpha', env = 'prod') {
  mockedStore.mockReturnValue({
    account: { organization: { name: 'Acme' }, user: { id: 'home-user' } },
    client,
    project,
    env,
  } as never);
}

describe('goal-aware Attention', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.sessionStorage.clear();
    window.localStorage.clear();
  });

  it('shows the answer before attention and applies a custom period to every Home answer query', async () => {
    const client = websiteClient() as Record<string, any>;
    const tower = controlTowerResponse();
    client.controlTower.mockResolvedValue({
      ...tower,
      attention: [{
        ...tower.attention[0],
        primary_action: {
          id: 'inspect_funnel',
          kind: 'navigate',
          label: 'Inspect funnel',
          href: '/analyze/funnels',
        },
      }],
    });
    setStore(client);
    const view = render(<MemoryRouter><Overview /></MemoryRouter>);

    expect(await screen.findByRole('heading', { name: 'Home' })).toBeInTheDocument();
    const period = screen.getByRole('group', { name: 'Analytics period' });
    expect(within(period).getByRole('button', { name: 'Today' })).toBeInTheDocument();
    expect(within(period).getByRole('button', { name: 'Custom' })).toBeInTheDocument();

    const metrics = screen.getByRole('list', { name: 'Key metrics' });
    const attention = screen.getByRole('region', { name: 'Needs attention' });
    expect(metrics.compareDocumentPosition(attention) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Website traffic trend' })).toBeInTheDocument();

    fireEvent.click(within(period).getByRole('button', { name: 'Custom' }));
    fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '2026-08-01' } });
    fireEvent.change(screen.getByLabelText('End date'), { target: { value: '2026-08-03' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply period' }));

    await waitFor(() => expect(client.operationalQuery).toHaveBeenLastCalledWith('alpha', expect.objectContaining({
      date_from: '2026-08-01T00:00:00.000Z',
      date_to: '2026-08-04T00:00:00.000Z',
    })));
    expect(client.query).toHaveBeenLastCalledWith('alpha', expect.objectContaining({
      kind: 'trend',
      date_from: '2026-08-01T00:00:00.000Z',
      date_to: '2026-08-04T00:00:00.000Z',
    }));
    expect(screen.getByText('Aug 1–3, 2026')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Inspect funnel/ })).toHaveAttribute(
      'href',
      '/analyze/funnels?range=custom&from=2026-08-01&to=2026-08-03',
    );
    expect(view.container.querySelector('.text-xs')).toBeNull();
  });

  it('renders the server-owned attention order instead of recomputing it in React', async () => {
    const client = websiteClient() as Record<string, any>;
    const server = controlTowerResponse();
    client.controlTower.mockResolvedValue({
      ...server,
      attention: [
        server.attention[0],
        {
          ...server.attention[0],
          id: 'server.funnel.blocked',
          title: 'Server-ordered funnel blocker',
          reason: 'The saved path has an unavailable step.',
          impact: 'The conversion answer remains partial.',
          delta: { value: -12.45, unit: 'percentage_point', direction: 'down', comparison_label: 'previous exact period' },
          evidence: { ...server.evidence, as_of: '2026-08-05T00:00:00.000Z', freshness: 'stale' },
          primary_action: { id: 'review_funnel', kind: 'navigate', label: 'Review funnel', href: '/analyze/funnels' },
        },
        {
          ...server.attention[0],
          id: 'server.usage.watch',
          title: 'Server-ordered usage watch',
          reason: 'Accepted volume is approaching the configured threshold.',
          impact: 'Ingest may be constrained if the pace continues.',
          evidence: { ...server.evidence, as_of: '2026-08-04T00:00:00.000Z', freshness: 'fresh' },
          primary_action: { id: 'review_usage', kind: 'navigate', label: 'Review usage', href: '/usage' },
        },
        {
          ...server.attention[0],
          id: 'server.release.watch',
          title: 'Server-ordered release watch',
          reason: 'A release still needs a bounded evidence review.',
          impact: 'The decision remains open until the evidence is reviewed.',
          evidence: { ...server.evidence, as_of: '2026-08-03T00:00:00.000Z', freshness: 'fresh' },
          primary_action: { id: 'review_release', kind: 'navigate', label: 'Review release', href: '/changes' },
        },
      ],
    });
    setStore(client);

    render(<MemoryRouter><Overview /></MemoryRouter>);

    expect(await screen.findByRole('heading', { name: 'Server-ordered measurement blocker' })).toBeInTheDocument();
    expect(screen.getByText('This item exists only in the canonical control-tower response.')).toBeInTheDocument();
    expect(screen.getByText('-12.5 pp · previous exact period')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Review definition/ })).toHaveAttribute('href', '/registry');
    expect(screen.getByRole('link', { name: /Review funnel/ })).toHaveAttribute('href', '/analyze/funnels');
    expect(screen.getByRole('link', { name: /Review usage/ })).toHaveAttribute('href', '/usage');
    expect(screen.getByRole('link', { name: /Review definition/ })).toHaveAttribute('data-variant', 'default');
    expect(screen.getByRole('link', { name: /Review funnel/ })).toHaveAttribute('data-variant', 'outline');
    expect(screen.getByRole('link', { name: /Review usage/ })).toHaveAttribute('data-variant', 'outline');
    expect(screen.getByText('View all 4 signals')).toBeInTheDocument();
    fireEvent.click(screen.getByText('View all 4 signals'));
    expect(screen.getByRole('link', { name: /Review release/ })).toHaveAttribute('href', '/changes');
    expect(screen.getByText('stale')).toBeInTheDocument();
    expect(client.controlTower).toHaveBeenCalledOnce();
    expect(client.controlTower).toHaveBeenCalledWith('alpha', 'prod', '30d');
  });

  it('renders a website answer from server facts with trust and responsive structure', async () => {
    const client = websiteClient() as Record<string, any>;
    const server = controlTowerResponse();
    client.controlTower.mockResolvedValue({
      ...server,
      home_funnel_key: 'website_signup',
      attention: [{
        ...server.attention[0],
        id: 'funnel.biggest_loss.website_signup',
        rule_id: 'funnel.biggest_loss',
        rule_version: 1,
        severity: 'medium',
        title: 'Biggest loss: Visited → Started signup',
        reason: '5 actors were lost at this step (62.5%).',
        impact: 'See whether qualified visitors begin signup.',
        delta: { value: -12.5, unit: 'percentage_point', direction: 'down', comparison_label: 'previous exact period' },
        affected: [{ kind: 'funnel', ref: 'website_signup' }],
        evidence: {
          ...server.evidence,
          state: 'trusted',
          source_refs: [{ kind: 'funnel', key: 'website_signup', goal: 'See whether qualified visitors begin signup.' }],
        },
        primary_action: { id: 'investigate_funnel_step', kind: 'navigate', label: 'Investigate step', href: '/analyze/funnels' },
      }],
      primary_action: { id: 'investigate_funnel_step', kind: 'navigate', label: 'Investigate step', href: '/analyze/funnels' },
    });
    client.schema.mockResolvedValue({
      identity: { active_links: 0 },
      observed_events_30d: [
        { event: 'page.viewed', count: 20, registered_share: 1, last_seen: new Date().toISOString() },
        { event: 'signup.started', count: 5, registered_share: 1, last_seen: '2026-08-05T10:00:00Z' },
      ],
    });
    client.funnels.mockResolvedValue([{
      id: 'unrelated-funnel',
      key: 'a_unrelated',
      name: 'Unrelated path',
      goal: 'Keep this alphabetical fallback out of the Home snapshot.',
      steps: [
        { metric_key: 'web_page_views', label: 'Visited' },
        { metric_key: 'web_page_views', label: 'Returned' },
      ],
      window_seconds: 86_400,
    }, {
      id: 'signup-funnel',
      key: 'website_signup',
      name: 'Visit to signup',
      goal: 'See whether qualified visitors begin signup.',
      steps: [
        { metric_key: 'web_page_views', label: 'Visited' },
        { metric_key: 'web_page_views', label: 'Started signup' },
      ],
      window_seconds: 86_400,
    }]);
    client.query.mockImplementation((_slug: string, query: { kind: string }) => query.kind === 'funnel'
      ? Promise.resolve({
        kind: 'funnel',
        steps: [
          { label: 'Visited', metric_key: 'web_page_views', purpose: 'Count accepted visits.', category: 'acquisition', actors: 8, conversion_from_prev: null, conversion_from_start: null },
          { label: 'Started signup', metric_key: 'web_page_views', purpose: 'Count signup starts.', category: 'activation', actors: 3, conversion_from_prev: 0.375, conversion_from_start: 0.375 },
        ],
        meta: { computed_at: '2026-08-06T00:00:00Z', date_range: { from: '2026-07-07T00:00:00Z', to: '2026-08-06T00:00:00Z' }, sampling: null, source: 'native' },
      })
      : Promise.resolve({
        kind: 'trend', series: [{ bucket: '2026-08-05T00:00:00Z', value: 20 }],
        meta: { computed_at: '2026-08-06T00:00:00Z', date_range: { from: '2026-07-07T00:00:00Z', to: '2026-08-06T00:00:00Z' }, sampling: null, source: 'native' },
      }));
    setStore(client);
    const view = render(<MemoryRouter><Overview /></MemoryRouter>);

    expect(await screen.findByRole('heading', { name: 'Home' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Customize dashboard' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Biggest loss: Visited → Started signup' })).toBeInTheDocument();
    expect(screen.getByText('Overall funnel conversion:')).toBeInTheDocument();
    const outcomes = screen.getByRole('list', { name: 'Key metrics' });
    expect(outcomes).toHaveClass('sm:grid-cols-2', 'xl:grid-cols-4');
    expect(outcomes.children).toHaveLength(4);
    expect(within(outcomes).getByText('8')).toBeInTheDocument();
    expect(within(outcomes).getByText('Last event · 30d')).toBeInTheDocument();
    expect(within(outcomes).getByText('page.viewed')).toBeInTheDocument();
    expect(screen.getByText(/Observed · Last 30 days · Trusted · 20 events ·/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Funnel snapshot' })).toBeInTheDocument();
    expect(screen.getByText('Visit to signup')).toBeInTheDocument();
    expect(screen.getByText('8 people')).toBeInTheDocument();
    expect(screen.getByText('37.5% from start')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Recent activity' })).toBeInTheDocument();
    expect(screen.getByText('20 events')).toBeInTheDocument();
    expect(screen.queryByText('Next action')).not.toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Website traffic trend' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Top sources' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Top pages' })).not.toBeInTheDocument();
    expect(view.container.querySelector('.text-xs')).toBeNull();
    expect(client.query).toHaveBeenCalledTimes(2);
    expect(client.query).toHaveBeenCalledWith('alpha', expect.objectContaining({
      kind: 'funnel',
      funnel: 'website_signup',
      env: 'prod',
    }));
    await waitFor(() => expect(telemetryCapture.mock.calls.filter(([event]) => event === 'home.answer_viewed')).toEqual([
      ['home.answer_viewed', { template_id: 'website_overview', trust: 'trusted' }, { distinctId: 'home-user' }],
    ]));
    view.rerender(<MemoryRouter><Overview /></MemoryRouter>);
    expect(telemetryCapture.mock.calls.filter(([event]) => event === 'home.answer_viewed')).toHaveLength(1);
    fireEvent.click(screen.getByRole('link', { name: /Investigate step/ }));
    expect(telemetryCapture.mock.calls.filter(([event]) => event === 'home.next_action_clicked')).toEqual([
      ['home.next_action_clicked', { action_id: 'explore_product' }, { distinctId: 'home-user' }],
    ]);
    view.unmount();

    const sameScope = render(<MemoryRouter><Overview /></MemoryRouter>);
    await screen.findByRole('heading', { name: 'Home' });
    expect(telemetryCapture.mock.calls.filter(([event]) => event === 'home.answer_viewed')).toHaveLength(1);
    sameScope.unmount();

    setStore(websiteClient(), 'beta');
    render(<MemoryRouter><Overview /></MemoryRouter>);
    await screen.findByRole('heading', { name: 'Home' });
    await waitFor(() => expect(telemetryCapture.mock.calls.filter(([event]) => event === 'home.answer_viewed')).toHaveLength(2));
  });

  it('keeps a useful four-card outcome strip when website measurement is not configured yet', async () => {
    const client = websiteClient() as Record<string, any>;
    const server = controlTowerResponse();
    client.controlTower.mockResolvedValue({
      ...server,
      attention: [{
        ...server.attention[0],
        id: 'onboarding.first_event_observed',
        rule_id: 'onboarding.first_event_observed',
        rule_version: 1,
        severity: 'low',
        title: 'No first event verified',
        reason: 'No accepted product event has been observed.',
        impact: 'Answers cannot be computed until a real event is stored.',
        affected: [{ kind: 'project', ref: 'alpha:prod' }],
        primary_action: { id: 'send_first_event', kind: 'navigate', label: 'Send an event', href: '/setup' },
      }],
      primary_action: { id: 'send_first_event', kind: 'navigate', label: 'Send an event', href: '/setup' },
    });
    client.metrics.mockResolvedValue([]);
    setStore(client);

    render(<MemoryRouter><Overview /></MemoryRouter>);

    expect(await screen.findByRole('heading', { name: 'Home' })).toBeInTheDocument();
    const outcomes = screen.getByRole('list', { name: 'Key metrics' });
    expect(within(outcomes).getByText('Visitors')).toBeInTheDocument();
    expect(within(outcomes).getByText('Sessions')).toBeInTheDocument();
    expect(within(outcomes).getByText('Page views')).toBeInTheDocument();
    expect(within(outcomes).getByText('Last event · 30d')).toBeInTheDocument();
    expect(within(outcomes).getAllByText('Not configured')).toHaveLength(3);
    expect(within(outcomes).getByText('No events')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Customize dashboard' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Send an event/ })).toHaveAttribute('href', '/setup');
  });

  it('keeps a temporary web answer failure distinct from missing measurement', async () => {
    const client = websiteClient();
    client.operationalQuery.mockRejectedValueOnce(new Error('temporary query failure'));
    setStore(client);

    render(<MemoryRouter><Overview /></MemoryRouter>);

    expect(await screen.findByText('Website answers are temporarily unavailable.')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Set up Web/ })).not.toBeInTheDocument();
    const outcomes = screen.getByRole('list', { name: 'Key metrics' });
    expect(within(outcomes).getAllByText('Unavailable').length).toBeGreaterThan(0);
    expect(within(outcomes).queryByText('Not configured')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry website answers' }));
    expect(await screen.findByText('8 people visited. organic brought the most measured traffic.')).toBeInTheDocument();
    expect(client.operationalQuery).toHaveBeenCalledTimes(2);
  });

  it('does not claim a biggest funnel drop-off when the funnel result is unavailable', async () => {
    const client = websiteClient();
    client.controlTower.mockResolvedValue({
      ...controlTowerResponse(),
      home_funnel_key: 'website_signup',
    });
    client.funnels.mockResolvedValue([{
      id: 'signup-funnel',
      key: 'website_signup',
      name: 'Visit to signup',
      goal: 'See whether qualified visitors begin signup.',
      steps: [
        { metric_key: 'web_page_views', label: 'Visited' },
        { metric_key: 'web_page_views', label: 'Started signup' },
      ],
      window_seconds: 86_400,
    }]);
    client.query.mockRejectedValue(new Error('funnel unavailable'));
    client.schema.mockResolvedValue({
      identity: { active_links: 0 },
      observed_events_30d: [{ event: 'page.viewed', count: 20, registered_share: 1, last_seen: '2026-08-06T10:00:00Z' }],
    });
    setStore(client);

    render(<MemoryRouter><Overview /></MemoryRouter>);

    expect(await screen.findByRole('heading', { name: 'Home' })).toBeInTheDocument();
    expect(screen.queryByText(/Biggest loss:/)).not.toBeInTheDocument();
    expect(screen.getAllByText('Unavailable').length).toBeGreaterThan(0);
  });

  it('keeps null intent as a usable legacy project without assigning a mode', async () => {
    setStore(websiteClient(null));
    render(<MemoryRouter><Overview /></MemoryRouter>);

    expect(await screen.findByRole('heading', { name: 'Home' })).toBeInTheDocument();
    expect(screen.queryByText(/Project mode is not set/)).not.toBeVisible();
    expect(screen.queryByText(/Nothing has been inferred/)).not.toBeVisible();
    fireEvent.click(screen.getByText('Project settings'));
    expect(screen.getByText(/Project mode is not set/)).toBeVisible();
    expect(screen.getByText(/Nothing has been inferred/)).toBeVisible();
  });

  it('does not claim a cross-surface path without identity evidence', async () => {
    setStore(websiteClient('both', 0));
    render(<MemoryRouter initialEntries={['/?range=today']}><Overview /></MemoryRouter>);

    expect(await screen.findByText('Website and product activity are not linked yet.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Website' })).toHaveAttribute('href', '/analyze/web?range=today');
    expect(screen.getByRole('link', { name: 'Product' })).toHaveAttribute('href', '/analyze/product?range=today');
    expect(screen.getByText(/Add stable identity evidence/)).toBeInTheDocument();
    expect(screen.queryByText(/drove.*activated/i)).not.toBeInTheDocument();
  });

  it('renders unavailable product evidence as unavailable, never as a fabricated zero', async () => {
    const client = websiteClient('website') as Record<string, any>;
    client.controlTower = vi.fn().mockResolvedValue({
      ...controlTowerResponse(),
      home_answer_surface: 'product',
      home_metric_key: 'weekly_active_users',
    });
    client.projectIntent = vi.fn().mockResolvedValue({ intent: { project_mode: 'product', goal_ids: ['feature_adoption'], primary_goal_id: 'feature_adoption' } });
    client.metrics = vi.fn().mockResolvedValue([productMetric]);
    client.query = vi.fn().mockRejectedValue(new Error('query unavailable'));
    client.measurementTrust = vi.fn().mockRejectedValue(new Error('trust unavailable'));
    setStore(client);
    render(<MemoryRouter><Overview /></MemoryRouter>);

    expect(await screen.findByRole('heading', { name: 'Home' })).toBeInTheDocument();
    expect(screen.getByText(/Observed · Last 30 days · Unavailable · event count unavailable ·/)).toBeInTheDocument();
    expect(screen.getAllByText('Unavailable').length).toBeGreaterThan(0);
    expect(screen.queryByText('0%')).not.toBeInTheDocument();

    expect(screen.queryByRole('button', { name: 'Customize dashboard' })).not.toBeInTheDocument();
  });
});
