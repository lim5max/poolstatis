import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountMode } from '../api/types';
import { useStore } from '../store';
import { ProductAnalytics } from './ProductAnalytics';

vi.mock('../store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../store')>()),
  useStore: vi.fn(),
}));

vi.mock('../analysis/charts', () => ({
  ManualVisualizationRenderer: ({ showEvidenceSummary }: { showEvidenceSummary?: boolean }) => (
    <div role="img" aria-label="Product answer chart" data-evidence-summary={String(showEvidenceSummary)}>Chart with table fallback</div>
  ),
}));

const mockedStore = vi.mocked(useStore);
const metric = {
  id: 'm1', key: 'weekly_active_users', name: 'Weekly active users',
  purpose: 'Count people who reach a meaningful product outcome.',
  category: 'activation', tags: [], type: 'unique_actors', source: { event: 'product.used' }, status: 'active',
  owner: null, deprecation_reason: null, deprecated_at: null,
} as const;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function accountMode({
  deployment = 'self_host', kind = 'secret', role = null, official = false,
}: {
  deployment?: 'hosted' | 'self_host';
  kind?: 'secret' | 'personal' | 'user';
  role?: 'owner' | 'admin' | 'member' | null;
  official?: boolean;
} = {}): AccountMode {
  return {
    schema_version: 1,
    deployment: { mode: deployment, hosted_account: deployment === 'hosted' ? 'available' : 'not_configured' },
    session: { kind, scope: kind === 'secret' ? 'project' : 'organization', role },
    capabilities: {
      portfolio: kind === 'secret' ? 'project_only' : 'available',
      compare_projects: kind !== 'secret',
      manage_profile: deployment === 'hosted' && kind === 'user',
      manage_personal_tokens: false,
      review_decisions: false,
      set_official_answers: official,
      configure_usage_entitlement: deployment === 'self_host' && kind === 'personal' ? 'available' : deployment === 'hosted' ? 'unavailable_hosted' : 'unavailable_scope',
      review_plan: 'unavailable',
      set_usage_alert: 'unavailable',
    },
    primary_action: deployment === 'hosted'
      ? { id: kind === 'user' ? 'manage_hosted_account' : 'sign_in_to_manage_account', kind: 'navigate', label: 'Manage account', href: '/profile' }
      : { id: 'open_local_setup', kind: 'navigate', label: 'Open local setup', href: '/setup' },
  };
}

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
      funnelInvestigations: vi.fn().mockResolvedValue([]),
      createFunnelInvestigation: vi.fn(),
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
      setAnalysisViewOfficial: vi.fn(),
      evaluateRelease: vi.fn(),
      accountMode: vi.fn().mockResolvedValue(accountMode()),
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

  it('runs the default answer automatically and applies a custom period without a Run answer gate', async () => {
    const current = productStore() as any;
    mockedStore.mockReturnValue(current);
    render(<MemoryRouter><ProductAnalytics /></MemoryRouter>);

    expect(await screen.findByRole('heading', { name: 'Product' })).toBeInTheDocument();
    await waitFor(() => expect(current.client.query).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: 'Run answer' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument();

    const period = screen.getByRole('group', { name: 'Analytics period' });
    const periodTrigger = within(period).getByRole('button', { name: /^Period:/ });
    periodTrigger.focus();
    fireEvent.keyDown(periodTrigger, { key: 'Enter', code: 'Enter' });
    fireEvent.click(screen.getByRole('menuitem', { name: /Custom period…/ }));
    fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '2026-08-10' } });
    fireEvent.change(screen.getByLabelText('End date'), { target: { value: '2026-08-12' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply period' }));

    await waitFor(() => expect(current.client.query).toHaveBeenCalledWith('alpha', expect.objectContaining({
      kind: 'trend',
      date_from: '2026-08-10T00:00:00.000Z',
      date_to: '2026-08-13T00:00:00.000Z',
    })));
    expect(current.client.measurementTrust).toHaveBeenCalledWith('alpha', expect.objectContaining({ since_days: 3 }));
  });

  it('keeps the current answer visible while a new period is loading', async () => {
    const current = productStore() as any;
    mockedStore.mockReturnValue(current);
    render(<MemoryRouter><ProductAnalytics /></MemoryRouter>);

    const answer = await screen.findByRole('region', { name: 'Canonical answer' }, { timeout: 4_000 });
    const previousResult = await current.client.query.mock.results[0].value;
    const pending = deferred<typeof previousResult>();
    current.client.query.mockImplementationOnce(() => pending.promise);

    const period = screen.getByRole('group', { name: 'Analytics period' });
    const periodTrigger = within(period).getByRole('button', { name: /^Period:/ });
    periodTrigger.focus();
    fireEvent.keyDown(periodTrigger, { key: 'Enter', code: 'Enter' });
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Today' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Updating…');
    expect(answer).toBeVisible();
    expect(screen.getByRole('region', { name: 'Canonical answer' })).toBeVisible();

    await act(async () => { pending.resolve(previousResult); });
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
  });

  it('puts templates and a real answer before advanced query controls', async () => {
    const current = productStore() as any;
    mockedStore.mockReturnValue(current);
    render(<MemoryRouter><ProductAnalytics /></MemoryRouter>);

    expect(await screen.findByRole('heading', { name: 'Product' })).toBeInTheDocument();
    expect(screen.getByRole('tablist', { name: 'Analysis view' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Product health' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Edit analysis').closest('details')).not.toHaveAttribute('open');

    await waitFor(() => expect(screen.getByText(/Observed · Trusted · 34 events ·/)).toBeInTheDocument());
    const answer = screen.getByRole('region', { name: 'Canonical answer' });
    expect(within(answer).getByText('Takeaway')).toBeInTheDocument();
    expect(within(answer).getByText('No safely comparable period headline')).toBeInTheDocument();
    expect(within(answer).getByText(metric.purpose)).toBeInTheDocument();
    expect(within(answer).getByRole('img', { name: 'Product answer chart' })).toHaveTextContent('table fallback');
    expect(within(answer).getByRole('img', { name: 'Product answer chart' })).toHaveAttribute('data-evidence-summary', 'false');
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

  it('lets an owner save the current answer directly as official', async () => {
    const current = productStore() as any;
    current.client.accountMode.mockResolvedValueOnce(accountMode({ deployment: 'hosted', kind: 'user', role: 'owner', official: true }));
    current.client.setAnalysisViewOfficial.mockResolvedValueOnce({ id: 'view-1', official: true });
    mockedStore.mockReturnValue(current);
    render(<MemoryRouter><ProductAnalytics /></MemoryRouter>);

    const official = await screen.findByRole('button', { name: 'Save as official' });
    expect(screen.getByRole('button', { name: 'Save answer' })).toHaveAttribute('data-variant', 'outline');
    fireEvent.click(official);

    await waitFor(() => expect(current.client.setAnalysisViewOfficial).toHaveBeenCalledWith('alpha', 'view-1', true));
    expect(current.client.createAnalysisView).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Official answer saved' })).toBeDisabled();
  });

  it('does not offer official status to a project secret', async () => {
    const current = productStore() as any;
    mockedStore.mockReturnValue(current);
    render(<MemoryRouter><ProductAnalytics /></MemoryRouter>);

    expect(await screen.findByRole('button', { name: 'Save answer' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save as official' })).not.toBeInTheDocument();
  });

  it('fails closed while the server-backed official capability is unavailable', async () => {
    const current = productStore() as any;
    current.client.accountMode.mockReturnValueOnce(new Promise(() => undefined));
    mockedStore.mockReturnValue(current);
    render(<MemoryRouter><ProductAnalytics /></MemoryRouter>);

    expect(await screen.findByRole('button', { name: 'Save answer' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save as official' })).not.toBeInTheDocument();
    expect(current.client.setAnalysisViewOfficial).not.toHaveBeenCalled();
  });

  it('keeps the saved answer and retries only the official mutation after a partial failure', async () => {
    const current = productStore() as any;
    current.client.accountMode.mockResolvedValueOnce(accountMode({ deployment: 'hosted', kind: 'user', role: 'admin', official: true }));
    current.client.setAnalysisViewOfficial
      .mockRejectedValueOnce(new Error('official write unavailable'))
      .mockResolvedValueOnce({ id: 'view-1', official: true });
    mockedStore.mockReturnValue(current);
    render(<MemoryRouter><ProductAnalytics /></MemoryRouter>);

    fireEvent.click(await screen.findByRole('button', { name: 'Save as official' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('The answer was saved, but official status was not applied.');
    expect(current.client.createAnalysisView).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Retry official status' }));

    await waitFor(() => expect(current.client.setAnalysisViewOfficial).toHaveBeenCalledTimes(2));
    expect(current.client.createAnalysisView).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Official answer saved' })).toBeDisabled();
  });

  it('opens the exact registry metric requested by a readiness dependency link', async () => {
    const exactMetric = {
      ...metric,
      id: 'm2',
      key: 'activation_completed',
      name: 'Activation completed',
      source: { event: 'activation.completed' },
    };
    const current = productStore() as any;
    current.client.metrics.mockResolvedValue([metric, exactMetric]);
    mockedStore.mockReturnValue(current);

    render(<MemoryRouter initialEntries={['/analyze/product?metric=activation_completed']}><ProductAnalytics /></MemoryRouter>);

    await waitFor(() => expect(current.client.query).toHaveBeenCalled());
    expect(current.client.query).toHaveBeenNthCalledWith(1, 'alpha', expect.objectContaining({
      kind: 'trend',
      metric: 'activation_completed',
      env: 'prod',
    }));
  });

  it('downgrades a saved answer when the query evidence is partial even if registry trust passed', async () => {
    const current = productStore() as any;
    current.client.query.mockResolvedValueOnce({
      kind: 'trend',
      series: [{ bucket: '2026-08-05T00:00:00Z', value: 8 }],
      answer: {
        state: 'ready',
        headline: 'Eight actors were observed.',
        takeaway: 'The metric returned an aggregate result.',
        why_it_matters: metric.purpose,
      },
      evidence: {
        state: 'partial',
        as_of: '2026-08-06T00:00:00Z',
        freshness: 'fresh',
        source_refs: [],
        warnings: [{ code: 'bounded_output', message: 'The server returned a bounded result.' }],
        unavailable_reasons: [],
      },
      meta: {
        computed_at: '2026-08-06T00:00:00Z',
        date_range: { from: '2026-07-07T00:00:00Z', to: '2026-08-06T00:00:00Z' },
        sampling: null,
        source: 'native',
      },
    });
    mockedStore.mockReturnValue(current);
    render(<MemoryRouter><ProductAnalytics /></MemoryRouter>);

    expect(await screen.findByText('Partial evidence')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save answer' }));
    await waitFor(() => expect(current.client.createAnalysisView).toHaveBeenCalledOnce());

    const payload = current.client.createAnalysisView.mock.calls[0][1];
    expect(payload.visualization_spec.trust.status).toBe('partial');
    expect(payload.evidence.state).toBe('partial');
    expect(payload.answer.state).toBe('partial');
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
    current.client.createFunnelInvestigation.mockResolvedValueOnce({
      investigation: {
        id: '11111111-1111-4111-8111-111111111111',
        env: 'prod',
        saved_funnel: { id: 'f1', key: 'checkout', name: 'Checkout', goal: 'Complete signup', steps: [], window_seconds: 604800 },
        transition: { from_step: 1, to_step: 2, from_metric: 'signup_started', to_metric: 'signup_completed', from_label: 'Started', to_label: 'Completed' },
        query_spec: {}, query_result: {}, evidence: {},
        lineage: { query_fingerprint: 'a'.repeat(64), result_fingerprint: 'b'.repeat(64), artifact_fingerprint: 'c'.repeat(64) },
        idempotency_key: 'test-idempotency', created_by: 'key:test', created_at: '2026-08-06T00:00:00Z',
      },
      idempotent: false,
    });
    mockedStore.mockReturnValue(current);

    render(<MemoryRouter initialEntries={['/analyze/funnels?funnel=checkout&env=prod&from_step=1&to_step=2']}><ProductAnalytics surface="funnels" /></MemoryRouter>);

    expect(await screen.findByRole('heading', { name: 'Funnels' })).toBeInTheDocument();
    expect(screen.queryByRole('tablist', { name: 'Analysis view' })).not.toBeInTheDocument();
    expect(screen.getByText('Activation funnel')).toBeInTheDocument();
    expect(screen.getByText('Edit funnel analysis')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Edit funnel analysis'));
    expect(screen.getByRole('combobox', { name: 'Saved funnel' })).toHaveTextContent('Checkout · checkout');

    expect(await screen.findByText('Biggest loss')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Started → Completed' })).toBeInTheDocument();
    expect(screen.getByText(/30 actors lost · 50% drop/)).toBeInTheDocument();
    expect(screen.getByText('Biggest absolute')).toHaveTextContent('Visited → Started');
    expect(screen.getByText('Biggest percentage')).toHaveTextContent('Started → Completed');
    expect(screen.getByText(/Stable step order resolved an equal loss/)).toBeInTheDocument();
    expect(current.client.releases).not.toHaveBeenCalled();
    expect(current.client.experiments).not.toHaveBeenCalled();
    expect(screen.queryByText('Related change evidence')).not.toBeInTheDocument();
    expect(screen.getByText(/does not infer a release or experiment/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Investigate Started → Completed' })).toHaveAttribute('data-variant', 'default');
    expect(screen.getByRole('button', { name: 'Save answer' })).toHaveAttribute('data-variant', 'outline');
    fireEvent.click(screen.getByRole('button', { name: 'Save answer' }));
    await waitFor(() => expect(current.client.createAnalysisView).toHaveBeenCalledOnce());
    expect(current.client.createAnalysisView.mock.calls[0][1].answer).toMatchObject({
      state: 'ready',
      primary_value: { value: 30, unit: 'percent', formatted: '30%' },
      delta: { value: -15, unit: 'percentage_point', direction: 'down' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Investigate Started → Completed' }));
    await waitFor(() => expect(current.client.createFunnelInvestigation).toHaveBeenCalledWith('alpha', expect.objectContaining({
      funnel: 'checkout', env: 'prod', from_step: 1, to_step: 2,
      date_from: '2026-07-07T00:00:00Z', date_to: '2026-08-06T00:00:00Z',
    })));
    expect(screen.getByText(/Saved artifact/)).toHaveTextContent('11111111-1111-4111-8111-111111111111');
    expect(screen.getByRole('link', { name: /Continue through Ship with artifact/ })).toHaveAttribute('href', '/changes?investigation=11111111-1111-4111-8111-111111111111');
    expect(screen.queryByRole('button', { name: 'Save proposal to Decisions' })).not.toBeInTheDocument();
    expect(current.client.evaluateRelease).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Copy bounded task' }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining('Poolstatis investigation: 11111111-1111-4111-8111-111111111111')));
    expect(current.client.query).toHaveBeenCalledTimes(1);
    expect(current.client.query).toHaveBeenNthCalledWith(1, 'alpha', expect.objectContaining({ kind: 'funnel', funnel: 'checkout', env: 'prod' }));
  });
});
