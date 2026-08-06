import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Decision, Experiment, Release } from '../api/types';
import { useStore } from '../store';
import { Changes } from '../screens/Changes';
import { Decisions } from '../screens/Decisions';
import {
  ShipLifecycleRail,
  ShipSectionNav,
  deriveDecisionStage,
  deriveExperimentStage,
  deriveReleaseStage,
  experimentOutcome,
  releaseOutcome,
} from './ship-lifecycle';

vi.mock('../store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../store')>()),
  useStore: vi.fn(),
}));

const mockedStore = vi.mocked(useStore);

const release = (status: Release['status']): Release => ({
  id: `release-${status}`,
  contract_id: 'contract-1',
  contract_key: 'activation_change',
  contract_revision: 2,
  contract_snapshot: {
    key: 'activation_change',
    name: 'Shorter activation',
    business_hypothesis: 'A shorter flow should help more new actors reach first value.',
    primary_metric_key: 'activation_completed',
    expected_direction: 'increase',
    target_filters: [],
    baseline_window_days: 7,
    observation_window_days: 7,
    guardrail_metric_keys: [],
    minimum_sample_size: 50,
    decision_owner: 'growth-team',
    references: {},
    status: 'active',
  },
  env: 'prod',
  repository: 'poolstatis/product',
  branch: 'feature/activation',
  commit_sha: '0123456789abcdef',
  pr_url: null,
  deployed_at: status === 'planned' ? null : '2026-08-04T10:00:00.000Z',
  flag_key: null,
  experiment_key: null,
  variant: null,
  originating_decision_id: null,
  status,
  idempotency_key: `fixture-${status}`,
  evaluation_attempts: 0,
  next_evaluation_at: null,
  retry_state: {},
  created_by: 'test',
  created_at: '2026-08-04T09:00:00.000Z',
  updated_at: '2026-08-04T10:00:00.000Z',
});

const experiment = (status: Experiment['status'], decision: Experiment['decision'] = null): Experiment => ({
  id: `experiment-${status}`,
  key: `activation_${status}`,
  name: 'Activation experiment',
  hypothesis: 'A shorter flow should improve measured activation.',
  flag_key: 'activation_flag',
  primary_metric_key: 'activation_completed',
  secondary_metric_keys: [],
  env: 'prod',
  control_variant_key: 'control',
  snapshot_integrity: 'frozen_at_start',
  status,
  started_at: status === 'draft' ? null : '2026-08-04T10:00:00.000Z',
  concluded_at: status === 'concluded' ? '2026-08-05T10:00:00.000Z' : null,
  decision,
  created_at: '2026-08-04T09:00:00.000Z',
  updated_at: '2026-08-05T10:00:00.000Z',
});

const decision = (status: Decision['status']): Decision => ({
  id: `decision-${status}`,
  release_id: 'release-observing',
  contract_id: 'contract-1',
  evidence_id: 'evidence-1',
  status,
  proposed_outcome: 'keep',
  proposed_rationale: 'The trusted primary metric improved without a guardrail regression.',
  accepted_outcome: status === 'approved' ? 'keep' : null,
  accepted_rationale: status === 'approved' ? 'Ship the measured improvement.' : null,
  current_revision: 1,
  created_by: 'agent',
  created_at: '2026-08-05T10:00:00.000Z',
  updated_at: '2026-08-05T10:00:00.000Z',
});

function decisionDetail(item: Decision, releaseEnv = 'prod') {
  const itemRelease = {
    ...release(item.status === 'proposed' ? 'observing' : 'decided'),
    id: item.release_id,
    env: releaseEnv,
  };
  return {
    decision: item,
    release: itemRelease,
    contract: { ...itemRelease.contract_snapshot, revision: itemRelease.contract_revision },
    evidence: {
      ready: true,
      source: 'native',
      baseline_window: { from: '2026-07-28T00:00:00.000Z', to: '2026-08-03T23:59:59.000Z' },
      observed_window: { from: '2026-08-04T00:00:00.000Z', to: '2026-08-05T23:59:59.000Z' },
      primary_evidence: {
        source: 'native',
        metric: { key: 'activation_completed', name: 'Activation completed', purpose: 'Measure completed activation.', category: 'activation', type: 'count' },
        baseline: { value: 20, actors: 40 },
        observed: { value: 30, actors: 45 },
        change: { relative: 0.5 },
      },
      guardrail_evidence: [],
      trust: { status: 'trusted', distinct_id_coverage: 1 },
      blockers: [],
      query_specs: { kind: 'trend', metric: 'activation_completed' },
    },
    revisions: [{
      id: 'revision-1', revision: 1, action: item.status, actor: 'owner',
      rationale: item.accepted_rationale ?? item.proposed_rationale, created_at: '2026-08-05T12:00:00.000Z',
    }],
  };
}

describe('Ship lifecycle', () => {
  beforeEach(() => vi.clearAllMocks());

  it('derives lifecycle stages only from real release, experiment, and decision statuses', () => {
    expect(deriveReleaseStage(release('planned'))).toBe('preparing');
    expect(deriveReleaseStage(release('deployed'))).toBe('running');
    expect(deriveReleaseStage(release('observing'))).toBe('waiting_for_evidence');
    expect(deriveReleaseStage(release('observing'), decision('proposed'))).toBe('ready_to_decide');
    expect(deriveReleaseStage(release('decided'), decision('approved'))).toBe('decided');
    expect(deriveExperimentStage(experiment('draft'))).toBe('preparing');
    expect(deriveExperimentStage(experiment('running'))).toBe('running');
    expect(deriveExperimentStage(experiment('concluded'))).toBe('concluded_without_decision');
    expect(deriveExperimentStage(experiment('concluded', {
      outcome: 'inconclusive', rationale: 'The evidence did not support a directional decision.',
    }))).toBe('decided');
    expect(deriveDecisionStage(decision('proposed'))).toBe('ready_to_decide');
    expect(deriveDecisionStage(decision('rejected'))).toBe('decided');
  });

  it('labels unavailable outcomes honestly instead of manufacturing a zero result', () => {
    expect(releaseOutcome(release('deployed'))).toEqual({
      title: 'Outcome not available yet',
      detail: 'The change is live, but no observation result is available yet.',
      available: false,
    });
    expect(experimentOutcome(experiment('concluded'))).toEqual({
      title: 'Concluded without decision',
      detail: 'The measurement window is closed and no rollout decision was recorded. This experiment is final.',
      available: false,
    });
  });

  it('distinguishes a recorded experiment decision from an explicit rollout change', () => {
    expect(experimentOutcome(experiment('concluded', {
      outcome: 'ship', rationale: 'The treatment produced the strongest trusted result.',
    }))).toEqual({
      title: 'Decision recorded · rollout unchanged',
      detail: 'Decision: Ship. The treatment produced the strongest trusted result.',
      available: true,
    });
    expect(experimentOutcome(experiment('concluded', {
      outcome: 'ship', rationale: 'The treatment produced the strongest trusted result.', ship_variant_key: 'treatment',
    }))).toEqual({
      title: 'treatment moved to 100%',
      detail: 'Decision: Ship. The treatment produced the strongest trusted result.',
      available: true,
    });
  });

  it('provides compact accessible navigation and a non-overflowing responsive lifecycle rail', () => {
    render(<MemoryRouter initialEntries={['/changes']}><Routes>
      <Route path="/changes" element={<>
        <ShipSectionNav current="lifecycle" />
        <ShipLifecycleRail counts={{ preparing: 1, running: 2, waiting_for_evidence: 1, ready_to_decide: 1, decided: 3, concluded_without_decision: 1 }} />
      </>} />
      <Route path="/experiments" element={<p>Experiments route opened</p>} />
    </Routes></MemoryRouter>);
    const navigation = screen.getByRole('navigation', { name: 'Ship views' });
    expect(navigation).toHaveClass('grid-cols-3', 'w-full');
    const links = within(navigation).getAllByRole('link');
    expect(links).toHaveLength(3);
    expect(links.every((link) => link.classList.contains('min-h-11'))).toBe(true);
    expect(within(navigation).getByRole('link', { name: 'Lifecycle' })).toHaveAttribute('aria-current', 'page');
    expect(within(navigation).getByRole('link', { name: 'Experiments & flags' })).toHaveAttribute('href', '/experiments');
    const rail = screen.getByRole('list', { name: 'Ship lifecycle' });
    expect(rail).toHaveClass('grid-cols-2', 'md:grid-cols-6');
    expect(within(rail).getAllByRole('listitem')).toHaveLength(6);
    expect(within(rail).getByText('Concluded')).toBeInTheDocument();
    fireEvent.click(within(navigation).getByRole('link', { name: 'Experiments & flags' }));
    expect(screen.getByText('Experiments route opened')).toBeInTheDocument();
  });

  it('uses typed releases, experiments, and decisions on the primary Ship landing', async () => {
    const releases = vi.fn().mockResolvedValue([release('observing')]);
    const decisions = vi.fn().mockResolvedValue([]);
    const experiments = vi.fn().mockResolvedValue([experiment('running')]);
    mockedStore.mockReturnValue({
      client: { releases, decisions, experiments },
      project: 'alpha',
      env: 'prod',
    } as never);

    render(<MemoryRouter><Changes /></MemoryRouter>);

    expect(await screen.findByRole('heading', { name: 'Ship' })).toBeInTheDocument();
    expect(releases).toHaveBeenCalledWith('alpha', { env: 'prod' });
    expect(decisions).toHaveBeenCalledWith('alpha', { env: 'prod' });
    expect(experiments).toHaveBeenCalledWith('alpha');
    expect(screen.getByRole('article', { name: 'Shorter activation' })).toHaveTextContent('Waiting for evidence');
    expect(screen.getByRole('article', { name: 'Activation experiment' })).toHaveTextContent('Running');
    expect(screen.getAllByText('Outcome not available yet')).toHaveLength(2);
    screen.getAllByText('Technical details').forEach((summary) => expect(summary.closest('details')).not.toHaveAttribute('open'));
  });

  it('renders concluded experiment rows without inventing a decision or rollout change', async () => {
    const closed = { ...experiment('concluded'), id: 'closed', name: 'Closed legacy test' };
    const recorded = {
      ...experiment('concluded', { outcome: 'ship', rationale: 'Record the result but preserve the current allocation.' }),
      id: 'recorded', name: 'Recorded outcome',
    };
    const delivered = {
      ...experiment('concluded', { outcome: 'ship', rationale: 'Move the trusted winner to all traffic.', ship_variant_key: 'treatment' }),
      id: 'delivered', name: 'Delivered winner',
    };
    mockedStore.mockReturnValue({
      client: {
        releases: vi.fn().mockResolvedValue([]),
        decisions: vi.fn().mockResolvedValue([]),
        experiments: vi.fn().mockResolvedValue([closed, recorded, delivered]),
      },
      project: 'alpha',
      env: 'prod',
    } as never);

    render(<MemoryRouter><Changes /></MemoryRouter>);

    expect(await screen.findByRole('article', { name: 'Closed legacy test' })).toHaveTextContent('Concluded');
    expect(screen.getByRole('article', { name: 'Closed legacy test' })).not.toHaveTextContent('Ready to decide');
    expect(screen.getByRole('article', { name: 'Closed legacy test' })).toHaveTextContent('Concluded without decision');
    expect(screen.getByRole('article', { name: 'Recorded outcome' })).toHaveTextContent('Decision recorded · rollout unchanged');
    expect(screen.getByRole('article', { name: 'Delivered winner' })).toHaveTextContent('treatment moved to 100%');
  });

  it('leads decision review with the human outcome and keeps audit detail collapsed', async () => {
    const approved = decision('approved');
    const detail = decisionDetail(approved);
    const listDecisions = vi.fn().mockResolvedValue([approved]);
    mockedStore.mockReturnValue({
      client: {
        decisions: listDecisions,
        decision: vi.fn().mockResolvedValue(detail),
        decisionInbox: vi.fn().mockResolvedValue([]),
        decisionHistory: vi.fn().mockResolvedValue({ items: [], next_cursor: null }),
        webhookDeliveries: vi.fn().mockResolvedValue([]),
        decisionExplanations: vi.fn().mockResolvedValue([]),
        decisionActions: vi.fn().mockResolvedValue([]),
      },
      project: 'alpha',
      env: 'prod',
    } as never);

    render(<MemoryRouter><Decisions /></MemoryRouter>);

    expect(await screen.findByRole('heading', { name: 'Decision review' })).toBeInTheDocument();
    expect(listDecisions).toHaveBeenCalledWith('alpha', { env: 'prod' });
    expect(screen.getByLabelText("Current environment prod")).toBeInTheDocument();
    expect(await screen.findAllByText('Decided: keep')).not.toHaveLength(0);
    expect(screen.getAllByText('Ship the measured improvement.').length).toBeGreaterThan(0);
    expect((await screen.findByText('Technical record')).closest('details')).not.toHaveAttribute('open');
    expect(screen.getByText('Decision operations & audit').closest('details')).not.toHaveAttribute('open');
  });

  it('reloads decisions on environment switch and blocks a stale cross-environment mutation', async () => {
    let currentEnv = 'prod';
    const proposed = decision('proposed');
    const detail = decisionDetail(proposed, 'prod');
    const listDecisions = vi.fn().mockResolvedValue([proposed]);
    const client = {
      decisions: listDecisions,
      decision: vi.fn().mockResolvedValue(detail),
      decisionInbox: vi.fn().mockResolvedValue([]),
      decisionHistory: vi.fn().mockResolvedValue({ items: [], next_cursor: null }),
      webhookDeliveries: vi.fn().mockResolvedValue([]),
      decisionExplanations: vi.fn().mockResolvedValue([]),
      decisionActions: vi.fn().mockResolvedValue([]),
    };
    mockedStore.mockImplementation(() => ({ client, project: 'alpha', env: currentEnv }) as never);

    const { rerender } = render(<MemoryRouter><Decisions /></MemoryRouter>);
    await screen.findByText('Review: keep');
    fireEvent.change(await screen.findByLabelText('Decision rationale'), {
      target: { value: 'The trusted evidence supports approving this production decision.' },
    });
    expect(screen.getByRole('button', { name: 'Approve proposal' })).toBeEnabled();

    currentEnv = 'dev';
    rerender(<MemoryRouter><Decisions /></MemoryRouter>);

    await waitFor(() => expect(listDecisions).toHaveBeenCalledWith('alpha', { env: 'dev' }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This decision belongs to prod. Switch back to that environment before reviewing it.",
    );
    expect(screen.getByRole('button', { name: 'Approve proposal' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Explain outcome' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Prepare' })).toBeDisabled();
  });
});
