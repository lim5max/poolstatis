import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
      releases: vi.fn().mockResolvedValue([]),
      experiments: vi.fn().mockResolvedValue([]),
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
      createAnalysisView: vi.fn().mockResolvedValue({ id: 'view-1' }),
      evaluateRelease: vi.fn(),
    },
  } as never;
}

function funnelResult(actors: number[]) {
  const losses = actors.slice(1).map((actorsAtStep, index) => ({
    from_step: index,
    to_step: index + 1,
    lost_actors: actors[index]! - actorsAtStep,
    drop_rate: actors[index]! > 0 ? (actors[index]! - actorsAtStep) / actors[index]! : null,
  }));
  return {
    kind: 'funnel',
    steps: actors.map((stepActors, index) => ({
      label: ['Visited', 'Started', 'Completed'][index],
      metric_key: ['signup_visited', 'signup_started', 'signup_completed'][index],
      purpose: ['Measure entry into the signup journey.', 'Measure signup intent.', 'Measure successful completion of signup.'][index],
      category: 'activation',
      actors: stepActors,
      conversion_from_prev: index === 0 ? 1 : stepActors / actors[index - 1]!,
      conversion_from_start: stepActors / actors[0]!,
    })),
    summary: {
      overall_conversion: actors.at(-1)! / actors[0]!,
      previous_overall_conversion: 0.45,
      delta_percentage_points: actors.at(-1)! / actors[0]! * 100 - 45,
      biggest_absolute_loss: losses.reduce((best, loss) => loss.lost_actors > best.lost_actors ? loss : best),
      biggest_percentage_loss: losses.reduce((best, loss) => (loss.drop_rate ?? -1) > (best.drop_rate ?? -1) ? loss : best),
    },
    evidence: {
      state: 'trusted', as_of: '2026-08-06T00:00:00Z', freshness: 'fresh', source_refs: [],
      warnings: [{ code: 'equal_biggest_absolute_loss', message: 'Stable step order resolved an equal loss.' }],
      unavailable_reasons: [],
    },
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
    const current = productStore() as any;
    mockedStore.mockReturnValue(current);
    render(<MemoryRouter><ProductAnalytics /></MemoryRouter>);

    expect(await screen.findByRole('heading', { name: 'Product' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Answer templates' })).toBeInTheDocument();
    expect(screen.getByText('Current answer')).toBeInTheDocument();
    expect(screen.getByText('Edit analysis').closest('details')).not.toHaveAttribute('open');

    fireEvent.click(screen.getByRole('button', { name: 'Run answer' }));
    await waitFor(() => expect(screen.getByText(/Observed · Trusted · 34 events ·/)).toBeInTheDocument());
    const answer = screen.getByRole('region', { name: 'Canonical answer' });
    expect(within(answer).getByText('Takeaway')).toBeInTheDocument();
    expect(within(answer).getByText('No safely comparable period headline')).toBeInTheDocument();
    expect(within(answer).getByText(metric.purpose)).toBeInTheDocument();
    expect(within(answer).getByRole('img', { name: 'Product answer chart' })).toHaveTextContent('table fallback');
    expect(within(answer).getByText(/Aggregation:/)).not.toBeVisible();
    fireEvent.click(within(answer).getByText('Evidence'));
    expect(within(answer).getByText(/Aggregation:/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Copy follow-up task' }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledOnce());
    const task = vi.mocked(navigator.clipboard.writeText).mock.calls[0]?.[0] as string;
    expect(task).toContain('Product health · Weekly active users');
    expect(task).toContain('Project: alpha');
    expect(task).toContain('Environment: prod');
    expect(task).not.toMatch(/raw event|sql|secret|token/i);

    fireEvent.click(screen.getByRole('button', { name: 'Save answer' }));
    await waitFor(() => expect(current.client.createAnalysisView).toHaveBeenCalledOnce());
    expect(current.client.createAnalysisView).toHaveBeenCalledWith('alpha', expect.objectContaining({
      title: 'Product health · Weekly active users',
      template_key: 'product-health',
      schema_version: 1,
      answer: expect.objectContaining({
        state: 'ready',
        why_it_matters: metric.purpose,
      }),
      evidence: expect.objectContaining({
        state: 'trusted',
        freshness: 'unknown',
        source_refs: [{ kind: 'metric', key: metric.key, purpose: metric.purpose }],
        warnings: [],
        unavailable_reasons: [],
        reproducible_query: expect.objectContaining({ kind: 'trend', metric: metric.key, env: 'prod' }),
      }),
    }));
    expect(screen.getByRole('button', { name: 'Answer saved' })).toBeDisabled();
    const savedPayload = current.client.createAnalysisView.mock.calls[0][1];
    expect(JSON.stringify(savedPayload)).not.toMatch(/"(?:sql|secret|token|distinct_id)"\s*:/i);
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
          { metric_key: 'signup_visited', label: 'Visited' },
          { metric_key: 'signup_started', label: 'Started' },
          { metric_key: 'signup_completed', label: 'Completed' },
        ],
        window_seconds: 604800,
      },
    ]) as any;
    current.client.query.mockResolvedValueOnce(funnelResult([100, 60, 30]));
    current.client.releases.mockResolvedValueOnce([{
      id: 'release-1', env: 'prod', status: 'observing', commit_sha: 'abcdef1234567890',
      deployed_at: '2026-07-20T00:00:00Z',
      contract_snapshot: { primary_metric_key: 'signup_completed', guardrail_metric_keys: [] },
    }]);
    current.client.experiments.mockResolvedValueOnce([{
      id: 'experiment-1', key: 'signup_copy', name: 'Signup copy', env: 'prod', status: 'running',
      primary_metric_key: 'signup_completed', secondary_metric_keys: [],
      started_at: '2026-07-18T00:00:00Z', concluded_at: null,
    }]);
    current.client.evaluateRelease.mockResolvedValueOnce({ decision: { id: 'decision-1' }, idempotent: false });
    mockedStore.mockReturnValue(current);

    render(<MemoryRouter initialEntries={['/analyze/funnels?funnel=checkout&env=prod&from_step=1&to_step=2']}><ProductAnalytics surface="funnels" /></MemoryRouter>);

    expect(await screen.findByRole('heading', { name: 'Funnels' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Answer templates' })).not.toBeInTheDocument();
    expect(screen.getByText('Activation funnel')).toBeInTheDocument();
    expect(screen.getByText('Edit funnel analysis')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Edit funnel analysis'));
    expect(screen.getByRole('combobox', { name: 'Saved funnel' })).toHaveTextContent('Checkout · checkout');

    fireEvent.click(screen.getByRole('button', { name: 'Run answer' }));
    expect(await screen.findByText('Biggest loss')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Started → Completed' })).toBeInTheDocument();
    expect(screen.getByText(/30 actors lost · 50% drop/)).toBeInTheDocument();
    expect(screen.getByText('Biggest absolute')).toHaveTextContent('Visited → Started');
    expect(screen.getByText('Biggest percentage')).toHaveTextContent('Started → Completed');
    expect(screen.getByText(/Stable step order resolved an equal loss/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Release abcdef1234/ })).toHaveAttribute('href', '/changes');
    expect(screen.getByRole('link', { name: /Experiment Signup copy/ })).toHaveAttribute('href', '/experiments');
    fireEvent.click(screen.getByRole('button', { name: 'Save proposal to Decisions' }));
    await waitFor(() => expect(current.client.evaluateRelease).toHaveBeenCalledWith('alpha', 'release-1'));
    expect(screen.getByRole('link', { name: 'Open proposal in Decisions' })).toHaveAttribute('href', '/decisions?decision=decision-1');
    expect(screen.queryByText(/cannot be saved directly to Decisions/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Investigate this step' })).toBeInTheDocument();
    expect(current.client.query).toHaveBeenCalledTimes(1);
    expect(current.client.query).toHaveBeenNthCalledWith(1, 'alpha', expect.objectContaining({ kind: 'funnel', funnel: 'checkout', env: 'prod' }));
  });
});
