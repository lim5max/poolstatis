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
  TrendChart: () => <div role="img" aria-label="Trend chart"><span>Day 1: 4</span><span>Day 2: 6</span></div>,
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

function websiteClient(intent: 'website' | 'both' | null = 'website', activeLinks = 0) {
  return {
    projectIntent: vi.fn().mockResolvedValue({ intent: intent ? { project_mode: intent, goal_ids: ['website_traffic'], primary_goal_id: 'website_traffic' } : null }),
    metrics: vi.fn().mockResolvedValue([webMetric]),
    funnels: vi.fn().mockResolvedValue([]),
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

describe('goal-aware Home', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.sessionStorage.clear();
    window.localStorage.clear();
  });

  it('renders a website answer from server facts with trust and responsive structure', async () => {
    setStore(websiteClient());
    const view = render(<MemoryRouter><Overview /></MemoryRouter>);

    expect(await screen.findByRole('heading', { name: 'Home' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Customize dashboard' })).toBeInTheDocument();
    const outcomes = screen.getByRole('group', { name: 'Key outcomes' });
    expect(outcomes).toHaveClass('grid-cols-2', 'lg:grid-cols-4');
    expect(within(outcomes).getByText('8')).toBeInTheDocument();
    expect(screen.getByText(/Observed · Trusted · 20 events ·/)).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Trend chart' })).toHaveTextContent('Day 1: 4');
    expect(screen.getByText('organic')).toBeInTheDocument();
    expect(screen.getByText('home')).toBeInTheDocument();
    await waitFor(() => expect(telemetryCapture.mock.calls.filter(([event]) => event === 'home.answer_viewed')).toEqual([
      ['home.answer_viewed', { template_id: 'website_overview', trust: 'trusted' }, { distinctId: 'home-user' }],
    ]));
    view.rerender(<MemoryRouter><Overview /></MemoryRouter>);
    expect(telemetryCapture.mock.calls.filter(([event]) => event === 'home.answer_viewed')).toHaveLength(1);
    fireEvent.click(screen.getByRole('link', { name: /Open Web/ }));
    expect(telemetryCapture.mock.calls.filter(([event]) => event === 'home.next_action_clicked')).toEqual([
      ['home.next_action_clicked', { action_id: 'open_web' }, { distinctId: 'home-user' }],
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

  it('keeps a useful four-card Home when website measurement is not configured yet', async () => {
    const client = websiteClient();
    client.metrics.mockResolvedValue([]);
    setStore(client);

    render(<MemoryRouter><Overview /></MemoryRouter>);

    expect(await screen.findByRole('heading', { name: 'Home' })).toBeInTheDocument();
    const outcomes = screen.getByRole('group', { name: 'Key outcomes' });
    expect(within(outcomes).getByText('Visitors')).toBeInTheDocument();
    expect(within(outcomes).getByText('Sessions')).toBeInTheDocument();
    expect(within(outcomes).getByText('Page views')).toBeInTheDocument();
    expect(within(outcomes).getByText('Average duration')).toBeInTheDocument();
    expect(within(outcomes).getAllByText('Not configured')).toHaveLength(4);
    fireEvent.click(screen.getByRole('button', { name: 'Customize dashboard' }));
    expect(await screen.findByRole('region', { name: 'Dashboard settings' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Card 1'), { target: { value: 'engaged_rate' } });
    expect(within(outcomes).getByText('Engagement rate')).toBeInTheDocument();
    expect(within(outcomes).queryByText('Visitors')).not.toBeInTheDocument();
    expect(localStorage.getItem('poolstatis.home.cards.alpha:prod:website')).toContain('engaged_rate');
  });

  it('keeps null intent as a usable legacy project without assigning a mode', async () => {
    setStore(websiteClient(null));
    render(<MemoryRouter><Overview /></MemoryRouter>);

    expect(await screen.findByRole('heading', { name: 'Home' })).toBeInTheDocument();
    expect(screen.getByText(/Project mode is not set/)).toBeInTheDocument();
    expect(screen.getByText(/Nothing has been inferred/)).toBeInTheDocument();
  });

  it('does not claim a cross-surface path without identity evidence', async () => {
    setStore(websiteClient('both', 0));
    render(<MemoryRouter><Overview /></MemoryRouter>);

    expect(await screen.findByText('Website and product activity are not linked yet.')).toBeInTheDocument();
    expect(screen.getByText(/Add stable identity evidence/)).toBeInTheDocument();
    expect(screen.queryByText(/drove.*activated/i)).not.toBeInTheDocument();
  });

  it('renders unavailable product evidence as unavailable, never as a fabricated zero', async () => {
    const client = websiteClient('website') as Record<string, any>;
    client.projectIntent = vi.fn().mockResolvedValue({ intent: { project_mode: 'product', goal_ids: ['feature_adoption'], primary_goal_id: 'feature_adoption' } });
    client.metrics = vi.fn().mockResolvedValue([productMetric]);
    client.query = vi.fn().mockRejectedValue(new Error('query unavailable'));
    client.measurementTrust = vi.fn().mockRejectedValue(new Error('trust unavailable'));
    setStore(client);
    render(<MemoryRouter><Overview /></MemoryRouter>);

    expect(await screen.findByRole('heading', { name: 'Home' })).toBeInTheDocument();
    expect(screen.getByText(/Observed · Unavailable · event count unavailable ·/)).toBeInTheDocument();
    expect(screen.getAllByText('Unavailable').length).toBeGreaterThan(0);
    expect(screen.queryByText('0%')).not.toBeInTheDocument();
  });
});
