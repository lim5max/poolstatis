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
    current.client.accountMode.mockResolvedValue(accountMode({ kind: 'personal', official: true }));
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
    const save = screen.getByRole('button', { name: 'Save answer' });
    const official = screen.getByRole('button', { name: 'Save as official' });
    expect(save).toBeDisabled();
    expect(official).toBeDisabled();
    fireEvent.click(save);
    fireEvent.click(official);
    expect(current.client.createAnalysisView).not.toHaveBeenCalled();

    await act(async () => { pending.resolve(previousResult); });
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Save answer' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Save as official' })).toBeEnabled();
  });

  it('puts templates and a real answer before advanced query controls', async () => {
    const current = productStore() as any;
    mockedStore.mockReturnValue(current);
    render(<MemoryRouter><ProductAnalytics /></MemoryRouter>);

    expect(await screen.findByRole('heading', { name: 'Product' })).toBeInTheDocument();
    const tabs = screen.getByRole('group', { name: 'Analysis view' });
    const selectedTab = within(tabs).getByRole('button', { name: 'Product health' });
    expect(selectedTab).toHaveAttribute('aria-pressed', 'true');
    expect(selectedTab).toHaveClass('border-b-2');
    expect(selectedTab).not.toHaveClass('focus-visible:ring-2');
    expect(screen.getByText('Edit analysis').closest('details')).not.toHaveAttribute('open');

    await waitFor(() => expect(screen.getByText('Trusted')).toBeInTheDocument());
    const answer = screen.getByRole('region', { name: 'Canonical answer' });
    expect(within(answer).queryByText('Takeaway')).not.toBeInTheDocument();
    expect(answer.parentElement).not.toHaveClass('border-l-4');
    expect(within(answer).getByText('No safely comparable period headline')).not.toBeVisible();
    expect(within(answer).getByText(metric.purpose)).not.toBeVisible();
    expect(within(answer).getByRole('img', { name: 'Product answer chart' })).toHaveTextContent('table fallback');
    expect(within(answer).getByRole('img', { name: 'Product answer chart' })).toHaveAttribute('data-evidence-summary', 'false');
    expect(within(answer).getByText(/Aggregation:/)).not.toBeVisible();
    fireEvent.click(within(answer).getByText('Details'));
    expect(within(answer).getByText(/Aggregation:/)).toBeVisible();
    expect(within(answer).getByText('No safely comparable period headline')).toBeVisible();
    expect(within(answer).getByText(metric.purpose)).toBeVisible();
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

  it('never reuses a saved answer id after its period changed while the save was pending', async () => {
    const current = productStore() as any;
    current.client.accountMode.mockResolvedValue(accountMode({ kind: 'personal', official: true }));
    const staleSave = deferred<{ id: string }>();
    current.client.createAnalysisView
      .mockImplementationOnce(() => staleSave.promise)
      .mockResolvedValueOnce({ id: 'view-current' });
    mockedStore.mockReturnValue(current);
    render(<MemoryRouter><ProductAnalytics /></MemoryRouter>);

    const saveButton = await screen.findByRole('button', { name: 'Save answer' });
    const initialResult = await current.client.query.mock.results[0].value;
    fireEvent.click(saveButton);
    expect(screen.getByRole('button', { name: 'Saving answer…' })).toBeDisabled();

    const pendingPeriod = deferred<typeof initialResult>();
    current.client.query.mockImplementationOnce(() => pendingPeriod.promise);
    const period = screen.getByRole('group', { name: 'Analytics period' });
    const periodTrigger = within(period).getByRole('button', { name: /^Period:/ });
    periodTrigger.focus();
    fireEvent.keyDown(periodTrigger, { key: 'Enter', code: 'Enter' });
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Today' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Updating…');

    await act(async () => { staleSave.resolve({ id: 'view-stale' }); });
    expect(current.client.setAnalysisViewOfficial).not.toHaveBeenCalled();
    await act(async () => { pendingPeriod.resolve(initialResult); });
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Save answer' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'Save as official' }));
    await waitFor(() => expect(current.client.setAnalysisViewOfficial).toHaveBeenCalledWith('alpha', 'view-current', true));
    expect(current.client.setAnalysisViewOfficial).not.toHaveBeenCalledWith('alpha', 'view-stale', true);
  });

  it('finishes a direct official save on its captured answer without contaminating the next period', async () => {
    const current = productStore() as any;
    current.client.accountMode.mockResolvedValue(accountMode({ kind: 'personal', official: true }));
    const staleOfficial = deferred<{ id: string }>();
    current.client.createAnalysisView
      .mockImplementationOnce(() => staleOfficial.promise)
      .mockResolvedValueOnce({ id: 'view-current' });
    mockedStore.mockReturnValue(current);
    render(<MemoryRouter><ProductAnalytics /></MemoryRouter>);

    const officialButton = await screen.findByRole('button', { name: 'Save as official' });
    const initialResult = await current.client.query.mock.results[0].value;
    fireEvent.click(officialButton);
    expect(screen.getByRole('button', { name: 'Saving official answer…' })).toBeDisabled();

    const pendingPeriod = deferred<typeof initialResult>();
    current.client.query.mockImplementationOnce(() => pendingPeriod.promise);
    const period = screen.getByRole('group', { name: 'Analytics period' });
    const periodTrigger = within(period).getByRole('button', { name: /^Period:/ });
    periodTrigger.focus();
    fireEvent.keyDown(periodTrigger, { key: 'Enter', code: 'Enter' });
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Today' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Updating…');

    await act(async () => { staleOfficial.resolve({ id: 'view-official-stale' }); });
    await waitFor(() => expect(current.client.setAnalysisViewOfficial).toHaveBeenCalledWith('alpha', 'view-official-stale', true));
    await act(async () => { pendingPeriod.resolve(initialResult); });
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Save answer' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Save as official' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'Save as official' }));
    await waitFor(() => expect(current.client.setAnalysisViewOfficial).toHaveBeenCalledWith('alpha', 'view-current', true));
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

    expect(await screen.findByText('Partial')).toBeInTheDocument();
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
    expect(screen.queryByRole('group', { name: 'Analysis view' })).not.toBeInTheDocument();
    expect(screen.getByText('Activation funnel')).toBeInTheDocument();
    expect(screen.getByText('Edit funnel analysis')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Edit funnel analysis'));
    expect(screen.getByRole('combobox', { name: 'Saved funnel' })).toHaveTextContent('Checkout · checkout');

    expect(await screen.findByText('Biggest drop-off')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Started → Completed' })).toBeInTheDocument();
    expect(screen.getByText(/30 actors lost · 50% drop/)).toBeInTheDocument();
    const steps = screen.getByRole('list', { name: 'Funnel steps' });
    expect(within(steps).getByText('Visited')).toBeInTheDocument();
    expect(within(steps).getByText('Started')).toBeInTheDocument();
    expect(within(steps).getByText('Completed')).toBeInTheDocument();
    expect(within(steps).getByText('30% from start')).toBeInTheDocument();
    expect(screen.queryByText('Previous conversion')).not.toBeInTheDocument();
    expect(screen.queryByText('Biggest absolute')).not.toBeInTheDocument();
    expect(screen.queryByText('Biggest percentage')).not.toBeInTheDocument();
    expect(screen.queryByText('Affected goal')).not.toBeInTheDocument();
    const evidenceNotes = screen.getByText('Evidence notes').closest('details');
    expect(evidenceNotes).not.toHaveAttribute('open');
    fireEvent.click(screen.getByText('Evidence notes'));
    expect(evidenceNotes).toHaveAttribute('open');
    expect(screen.getByText(/Stable step order resolved an equal loss/)).toBeInTheDocument();
    expect(current.client.releases).not.toHaveBeenCalled();
    expect(current.client.experiments).not.toHaveBeenCalled();
    expect(screen.queryByText('Related change evidence')).not.toBeInTheDocument();
    expect(screen.queryByText(/does not infer a release or experiment/)).not.toBeInTheDocument();
    expect(screen.queryByText('Immutable investigation evidence')).not.toBeInTheDocument();
    expect(screen.queryByText('Explicit Ship handoff')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save investigation' })).toHaveAttribute('data-variant', 'outline');
    expect(screen.getByRole('button', { name: 'Save answer' })).toHaveAttribute('data-variant', 'outline');
    fireEvent.click(screen.getByRole('button', { name: 'Save answer' }));
    await waitFor(() => expect(current.client.createAnalysisView).toHaveBeenCalledOnce());
    expect(current.client.createAnalysisView.mock.calls[0][1].answer).toMatchObject({
      state: 'ready',
      primary_value: { value: 30, unit: 'percent', formatted: '30%' },
      delta: { value: -15, unit: 'percentage_point', direction: 'down' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save investigation' }));
    await waitFor(() => expect(current.client.createFunnelInvestigation).toHaveBeenCalledWith('alpha', expect.objectContaining({
      funnel: 'checkout', env: 'prod', from_step: 1, to_step: 2,
      date_from: '2026-07-07T00:00:00Z', date_to: '2026-08-06T00:00:00Z',
    })));
    expect(screen.getByRole('status')).toHaveTextContent('Investigation 11111111 saved');
    expect(screen.getByRole('link', { name: 'Open in Ship' })).toHaveAttribute('href', '/changes?investigation=11111111-1111-4111-8111-111111111111');
    expect(screen.queryByRole('button', { name: 'Save proposal to Decisions' })).not.toBeInTheDocument();
    expect(current.client.evaluateRelease).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Copy task' }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining('Poolstatis investigation: 11111111-1111-4111-8111-111111111111')));
    expect(current.client.query).toHaveBeenCalledTimes(1);
    expect(current.client.query).toHaveBeenNthCalledWith(1, 'alpha', expect.objectContaining({ kind: 'funnel', funnel: 'checkout', env: 'prod' }));
  });
});
