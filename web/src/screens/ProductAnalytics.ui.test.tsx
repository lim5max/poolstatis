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
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
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
    expect(screen.getByText(/Aggregation:/)).not.toBeVisible();
    fireEvent.click(screen.getByText('How this is calculated'));
    expect(screen.getByText(/Aggregation:/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Copy follow-up task' }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledOnce());
    const task = vi.mocked(navigator.clipboard.writeText).mock.calls[0]?.[0] as string;
    expect(task).toContain('Product health · Weekly active users');
    expect(task).toContain('Project: alpha');
    expect(task).toContain('Environment: prod');
    expect(task).not.toMatch(/raw event|sql|secret|token/i);
  });

  it('gives funnels a focused answer surface without the product template grid', async () => {
    const current = productStore([
      {
        id: 'f1', key: 'signup', name: 'Signup', goal: 'Find signup drop-off.',
        steps: [
          { metric_key: 'signup_started', label: 'Started' },
          { metric_key: 'signup_completed', label: 'Completed' },
        ],
        window_seconds: 604800,
      },
      {
        id: 'f2', key: 'checkout', name: 'Checkout', goal: 'Find checkout drop-off.',
        steps: [
          { metric_key: 'signup_started', label: 'Started' },
          { metric_key: 'signup_completed', label: 'Completed' },
        ],
        window_seconds: 604800,
      },
    ]) as any;
    current.client.query
      .mockResolvedValueOnce(funnelResult([100, 40]))
      .mockResolvedValueOnce(funnelResult([80, 48]));
    mockedStore.mockReturnValue(current);

    render(<MemoryRouter initialEntries={['/analyze/funnels?funnel=checkout&env=prod&from_step=0&to_step=1']}><ProductAnalytics surface="funnels" /></MemoryRouter>);

    expect(await screen.findByRole('heading', { name: 'Funnels' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Answer templates' })).not.toBeInTheDocument();
    expect(screen.getByText('Activation funnel')).toBeInTheDocument();
    expect(screen.getByText('Edit funnel analysis')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Edit funnel analysis'));
    expect(screen.getByRole('combobox', { name: 'Saved funnel' })).toHaveTextContent('Checkout · checkout');

    fireEvent.click(screen.getByRole('button', { name: 'Run answer' }));
    expect(await screen.findByText('Biggest loss')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Started → Completed' })).toBeInTheDocument();
    expect(screen.getByText(/60 actors lost · 60% drop · \+20 pp vs previous period/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Investigate this step' })).toBeInTheDocument();
    expect(current.client.query).toHaveBeenCalledTimes(2);
    expect(current.client.query).toHaveBeenNthCalledWith(1, 'alpha', expect.objectContaining({ kind: 'funnel', funnel: 'checkout', env: 'prod' }));
  });
});
