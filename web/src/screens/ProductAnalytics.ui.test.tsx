import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../store';
import { ProductAnalytics } from './ProductAnalytics';

vi.mock('../store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../store')>()),
  useStore: vi.fn(),
}));

vi.mock('../analysis/charts', () => ({
  ManualVisualizationRenderer: () => <div role="img" aria-label="Product answer chart">Chart with table fallback</div>,
}));

const mockedStore = vi.mocked(useStore);
const metric = {
  id: 'm1', key: 'weekly_active_users', name: 'Weekly active users',
  purpose: 'Count people who reach a meaningful product outcome.',
  category: 'activation', tags: [], type: 'unique_actors', source: { event: 'product.used' }, status: 'active',
  owner: null, deprecation_reason: null, deprecated_at: null,
} as const;

function productStore(funnels: unknown[] = []) {
  return {
    project: 'alpha',
    env: 'prod',
    client: {
      metrics: vi.fn().mockResolvedValue([metric]),
      funnels: vi.fn().mockResolvedValue(funnels),
      properties: vi.fn().mockResolvedValue([]),
      query: vi.fn().mockResolvedValue({
        kind: 'trend',
        series: [{ bucket: '2026-08-05T00:00:00Z', value: 8 }],
        meta: {
          computed_at: '2026-08-06T00:00:00Z',
          date_range: { from: '2026-07-07T00:00:00Z', to: '2026-08-06T00:00:00Z' },
          sampling: null,
          source: 'native',
        },
      }),
      measurementTrust: vi.fn().mockResolvedValue({
        status: 'trusted',
        primary_metric: { key: metric.key, purpose: metric.purpose, category: 'activation', observed_events: 34, observed_actors: 8, registered_coverage: 1 },
        identity: { distinct_id_coverage: 1, raw_actors: 8, resolved_actors: 8 }, properties: [], blockers: [], warnings: [],
      }),
    },
  } as never;
}

function funnelResult(actors: number[]) {
  return {
    kind: 'funnel',
    steps: [
      { label: 'Started', metric_key: 'signup_started', purpose: 'Measure entry into the signup journey.', category: 'activation', actors: actors[0], conversion_from_prev: null, conversion_from_start: 1 },
      { label: 'Completed', metric_key: 'signup_completed', purpose: 'Measure successful completion of signup.', category: 'activation', actors: actors[1], conversion_from_prev: actors[1]! / actors[0]!, conversion_from_start: actors[1]! / actors[0]! },
    ],
    meta: { computed_at: '2026-08-06T00:00:00Z', date_range: { from: '2026-07-07T00:00:00Z', to: '2026-08-06T00:00:00Z' }, sampling: null, source: 'native' },
  };
}

describe('Product answer-first surface', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedStore.mockReturnValue(productStore());
  });

  it('puts templates and a real answer before advanced query controls', async () => {
    render(<MemoryRouter><ProductAnalytics /></MemoryRouter>);

    expect(await screen.findByRole('heading', { name: 'Product' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Answer templates' })).toBeInTheDocument();
    expect(screen.getByText('Current answer')).toBeInTheDocument();
    expect(screen.getByText('Edit analysis').closest('details')).not.toHaveAttribute('open');

    fireEvent.click(screen.getByRole('button', { name: 'Run answer' }));
    await waitFor(() => expect(screen.getByText(/Observed · Trusted · 34 events ·/)).toBeInTheDocument());
    expect(screen.getByText('Takeaway')).toBeInTheDocument();
    expect(screen.getByText('Previous exact period')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Product answer chart' })).toHaveTextContent('table fallback');
  });

  it('gives funnels a focused answer surface without the product template grid', async () => {
    const current = productStore([{
      id: 'f1', key: 'signup', name: 'Signup', goal: 'Find signup drop-off.',
      steps: [
        { metric_key: 'signup_started', label: 'Started' },
        { metric_key: 'signup_completed', label: 'Completed' },
      ],
      window_seconds: 604800,
    }]) as any;
    current.client.query
      .mockResolvedValueOnce(funnelResult([100, 40]))
      .mockResolvedValueOnce(funnelResult([80, 48]));
    mockedStore.mockReturnValue(current);

    render(<MemoryRouter><ProductAnalytics surface="funnels" /></MemoryRouter>);

    expect(await screen.findByRole('heading', { name: 'Funnels' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Answer templates' })).not.toBeInTheDocument();
    expect(screen.getByText('Activation funnel')).toBeInTheDocument();
    expect(screen.getByText('Edit funnel analysis')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Run answer' }));
    expect(await screen.findByText('Biggest loss')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Started → Completed' })).toBeInTheDocument();
    expect(screen.getByText(/60 actors lost · 60% drop · \+20 pp vs previous period/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Investigate this step' })).toBeInTheDocument();
    expect(current.client.query).toHaveBeenCalledTimes(2);
  });
});
