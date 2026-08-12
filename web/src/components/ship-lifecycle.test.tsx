import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountMode, Decision, DecisionAction, Experiment, Release } from '../api/types';
import { useStore } from '../store';
import { Changes } from '../screens/Changes';
import { Decisions } from '../screens/Decisions';
import {
  ShipLifecycleRail,
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

const hostedOwnerMode: AccountMode = {
  schema_version: 1,
  deployment: { mode: 'hosted', hosted_account: 'available' },
  session: { kind: 'user', scope: 'organization', role: 'owner' },
  capabilities: {
    portfolio: 'available', compare_projects: true, manage_profile: true,
    manage_personal_tokens: true, review_decisions: true, set_official_answers: true,
  },
  primary_action: { id: 'manage_hosted_account', kind: 'navigate', label: 'Manage account', href: '/profile' },
};

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

  it('provides a non-overflowing responsive lifecycle rail without duplicate Ship navigation', () => {
    render(<ShipLifecycleRail counts={{ preparing: 1, running: 2, waiting_for_evidence: 1, ready_to_decide: 1, decided: 3, concluded_without_decision: 1 }} />);
    expect(screen.queryByRole('navigation', { name: 'Ship views' })).not.toBeInTheDocument();
    const rail = screen.getByRole('list', { name: 'Ship lifecycle' });
    expect(rail).toHaveClass('grid-cols-2', 'md:grid-cols-6');
    expect(screen.getAllByRole('listitem')).toHaveLength(6);
    expect(screen.getByText('Concluded')).toBeInTheDocument();
  });

  it('uses typed releases, experiments, and decisions on the primary Ship landing', async () => {
    const releases = vi.fn().mockResolvedValue([release('observing')]);
    const decisions = vi.fn().mockResolvedValue([]);
    const experiments = vi.fn().mockResolvedValue([experiment('running')]);
    mockedStore.mockReturnValue({
      client: { releases, decisions, experiments, contracts: vi.fn().mockResolvedValue([]) },
      project: 'alpha',
      env: 'prod',
    } as never);

    render(<MemoryRouter><Changes /></MemoryRouter>);

    expect(await screen.findByRole('heading', { name: 'Ship' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Ship views' })).not.toBeInTheDocument();
    expect(releases).toHaveBeenCalledWith('alpha', { env: 'prod' });
    expect(decisions).toHaveBeenCalledWith('alpha', { env: 'prod' });
    expect(experiments).toHaveBeenCalledWith('alpha');
    expect(screen.getByRole('article', { name: 'Shorter activation' })).toHaveTextContent('Waiting for evidence');
    const experimentRow = screen.getByRole('article', { name: 'Activation experiment' });
    expect(experimentRow).toHaveTextContent('Running');
    expect(experimentRow).toHaveTextContent('The experiment is collecting exposure evidence.');
    expect(experimentRow).toHaveTextContent('Linked release decision ownerUnavailable');
    expect(experimentRow).toHaveTextContent('Linked release decision dateUnavailable');
    expect(screen.getAllByText('Outcome not available yet')).toHaveLength(2);
    screen.getAllByText('Technical details').forEach((summary) => expect(summary.closest('details')).not.toHaveAttribute('open'));
  });

  it('labels owner and timing as linked-release decision metadata', async () => {
    const linked = {
      ...release('observing'),
      experiment_key: 'activation_running',
    };
    mockedStore.mockReturnValue({
      client: {
        releases: vi.fn().mockResolvedValue([linked]),
        decisions: vi.fn().mockResolvedValue([]),
        experiments: vi.fn().mockResolvedValue([experiment('running')]),
        contracts: vi.fn().mockResolvedValue([]),
      },
      project: 'alpha',
      env: 'prod',
    } as never);

    render(<MemoryRouter><Changes /></MemoryRouter>);

    const row = await screen.findByRole('article', { name: 'Activation experiment' });
    expect(row).toHaveTextContent('Linked release decision ownergrowth-team');
    expect(row).toHaveTextContent(/Linked release decision date.*Aug 11, 2026/);
    fireEvent.click(within(row).getByText('Technical details'));
    expect(row).toHaveTextContent(`Linked release ${linked.id}`);
  });

  it('marks the exact release requested by a Decisions handoff', async () => {
    const target = {
      ...release('deployed'),
      id: 'release-target',
      contract_snapshot: { ...release('deployed').contract_snapshot, name: 'Target release' },
    };
    const other = {
      ...release('deployed'),
      id: 'release-other',
      contract_snapshot: { ...release('deployed').contract_snapshot, name: 'Other release' },
    };
    mockedStore.mockReturnValue({
      client: {
        releases: vi.fn().mockResolvedValue([other, target]),
        decisions: vi.fn().mockResolvedValue([]),
        experiments: vi.fn().mockResolvedValue([]),
        contracts: vi.fn().mockResolvedValue([]),
      },
      project: 'alpha',
      env: 'prod',
      tokenKind: 'user',
      account: { membership: { role: 'owner' } },
    } as never);

    render(<MemoryRouter initialEntries={['/changes?release=release-target']}><Changes /></MemoryRouter>);

    expect(await screen.findByRole('article', { name: 'Target release' })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('article', { name: 'Other release' })).not.toHaveAttribute('aria-current');
  });

  it('reads an explicit funnel investigation handoff without treating it as a release decision', async () => {
    const funnelInvestigation = vi.fn().mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111', env: 'prod',
      saved_funnel: {
        id: 'funnel-1', key: 'activation', name: 'Activation',
        goal: 'Measure whether actors reach the first meaningful outcome.',
        steps: [], window_seconds: 86400,
      },
      transition: {
        from_step: 0, to_step: 1, from_metric: 'started', to_metric: 'completed',
        from_label: 'Started', to_label: 'Completed',
      },
      query_spec: {}, query_result: {}, evidence: {},
      lineage: { query_fingerprint: 'a'.repeat(64), result_fingerprint: 'b'.repeat(64) },
      idempotency_key: 'ship-context', created_by: 'key:test', created_at: '2026-08-12T00:00:00.000Z',
    });
    const evaluateRelease = vi.fn();
    mockedStore.mockReturnValue({
      client: {
        releases: vi.fn().mockResolvedValue([release('deployed')]),
        decisions: vi.fn().mockResolvedValue([]),
        experiments: vi.fn().mockResolvedValue([]),
        contracts: vi.fn().mockResolvedValue([]),
        funnelInvestigation,
        evaluateRelease,
      },
      project: 'alpha', env: 'prod',
    } as never);

    render(<MemoryRouter initialEntries={['/changes?investigation=11111111-1111-4111-8111-111111111111']}><Changes /></MemoryRouter>);

    expect(await screen.findByText('Investigation carried into Ship')).toBeInTheDocument();
    expect(funnelInvestigation).toHaveBeenCalledWith('alpha', '11111111-1111-4111-8111-111111111111');
    expect(screen.getByText('Started → Completed')).toBeInTheDocument();
    expect(screen.getByText(/does not attach itself to a release/)).toBeInTheDocument();
    expect(screen.getByText('Evidence only')).toBeInTheDocument();
    expect(evaluateRelease).not.toHaveBeenCalled();
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
        contracts: vi.fn().mockResolvedValue([]),
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
    const preparedAction: DecisionAction = {
      id: 'action-1', decision_id: approved.id, release_id: detail.release.id, evidence_id: 'evidence-1',
      decision_revision: 1, action_type: 'schedule_observation', status: 'prepared',
      target: { repository: 'poolstatis/product', env: 'prod' },
      payload: { at: '2026-08-12T10:00:00.000Z' },
      expected_effect: 'Schedule one bounded observation without changing traffic.',
      undo: { action: 'cancel_scheduled_observation', scheduled_at: '2026-08-12T10:00:00.000Z' },
      confirmation_fingerprint: 'f'.repeat(64), idempotency_key: 'action-1', prepared_by: 'owner',
      approved_by: null, approved_at: null, executed_at: null, result: null, error_code: null,
      error_message: null, created_at: '2026-08-11T10:00:00.000Z', updated_at: '2026-08-11T10:00:00.000Z',
    };
    const listDecisions = vi.fn().mockResolvedValue([approved]);
    mockedStore.mockReturnValue({
      client: {
        decisions: listDecisions,
        releases: vi.fn().mockResolvedValue([detail.release]),
        decision: vi.fn().mockResolvedValue(detail),
        decisionInbox: vi.fn().mockResolvedValue([]),
        decisionHistory: vi.fn().mockResolvedValue({ items: [], next_cursor: null }),
        webhookDeliveries: vi.fn().mockResolvedValue([]),
        decisionExplanations: vi.fn().mockResolvedValue([]),
        decisionActions: vi.fn().mockResolvedValue([preparedAction]),
        accountMode: vi.fn().mockResolvedValue(hostedOwnerMode),
      },
      project: 'alpha',
      env: 'prod',
      tokenKind: 'user',
      account: { membership: { role: 'owner' } },
    } as never);

    render(<MemoryRouter><Decisions /></MemoryRouter>);

    expect(await screen.findByRole('heading', { name: 'Decision review' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: /Decided: keep/ })).toHaveClass('border-brand-strong', 'bg-primary/10'));
    expect(screen.queryByRole('navigation', { name: 'Ship views' })).not.toBeInTheDocument();
    expect(listDecisions).toHaveBeenCalledWith('alpha', { env: 'prod' });
    expect(screen.getByLabelText("Current environment prod")).toBeInTheDocument();
    expect(await screen.findAllByText('Decided: keep')).not.toHaveLength(0);
    expect(screen.getAllByText('Ship the measured improvement.').length).toBeGreaterThan(0);
    expect(await screen.findByText('Review before deciding')).toBeInTheDocument();
    expect(await screen.findByText('Assumptions')).toBeInTheDocument();
    expect(screen.getByText(/does not deploy code, change a flag, or roll back traffic/)).toBeInTheDocument();
    expect(await screen.findByLabelText('Frozen target')).toHaveTextContent(/"repository": "poolstatis\/product"/);
    expect(screen.getByLabelText('Frozen payload')).toHaveTextContent(/"at": "2026-08-12T10:00:00.000Z"/);
    expect(screen.getByLabelText('Frozen undo')).toHaveTextContent(/"action": "cancel_scheduled_observation"/);
    expect(screen.getByLabelText('Full action confirmation fingerprint')).toHaveTextContent('f'.repeat(64));
    expect(screen.getByRole('button', { name: 'Approve shown payload' })).toBeInTheDocument();
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
      releases: vi.fn().mockResolvedValue([detail.release]),
      decision: vi.fn().mockResolvedValue(detail),
      decisionInbox: vi.fn().mockResolvedValue([]),
      decisionHistory: vi.fn().mockResolvedValue({ items: [], next_cursor: null }),
      webhookDeliveries: vi.fn().mockResolvedValue([]),
      decisionExplanations: vi.fn().mockResolvedValue([]),
      decisionActions: vi.fn().mockResolvedValue([]),
      accountMode: vi.fn().mockResolvedValue(hostedOwnerMode),
    };
    mockedStore.mockImplementation(() => ({
      client, project: 'alpha', env: currentEnv,
      tokenKind: 'user', account: { membership: { role: 'owner' } },
    }) as never);

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
    expect(await screen.findByRole('button', { name: 'Explain outcome' })).toBeDisabled();
    expect(await screen.findByRole('button', { name: 'Prepare' })).toBeDisabled();
  });

  it('registers the first deployed release from a real active contract without showing zero lifecycle KPIs', async () => {
    const registerRelease = vi.fn().mockResolvedValue({ id: 'new-release', idempotent: false });
    const snapshot = release('planned').contract_snapshot;
    const contract = {
      ...snapshot,
      id: 'contract-1',
      revision: 4,
      declaration_hash: 'a'.repeat(64),
      created_by: 'test',
      created_at: '2026-08-11T10:00:00.000Z',
      updated_at: '2026-08-11T10:00:00.000Z',
    };
    mockedStore.mockReturnValue({
      client: {
        releases: vi.fn().mockResolvedValue([]),
        decisions: vi.fn().mockResolvedValue([]),
        experiments: vi.fn().mockResolvedValue([]),
        contracts: vi.fn().mockResolvedValue([contract]),
        registerRelease,
      },
      project: 'alpha',
      env: 'prod',
    } as never);

    render(<MemoryRouter><Changes /></MemoryRouter>);

    expect(await screen.findByText('Start the first release decision loop')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Ship lifecycle' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Register release' }));
    fireEvent.change(screen.getByLabelText('Release repository'), { target: { value: 'acme/product' } });
    fireEvent.change(screen.getByLabelText('Release commit SHA'), { target: { value: 'abcdef1234567' } });
    fireEvent.change(screen.getByLabelText('Release deployed at'), { target: { value: '2026-08-11T15:24:00Z' } });
    fireEvent.change(screen.getByLabelText('Release deployment id'), { target: { value: 'deploy-2026-08-11-01' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Register release' }).at(-1)!);

    await waitFor(() => expect(registerRelease).toHaveBeenCalledWith('alpha', expect.objectContaining({
      idempotency_key: 'admin:deploy-2026-08-11-01',
      contract_key: 'activation_change',
      repository: 'acme/product',
      commit_sha: 'abcdef1234567',
      deployed_at: '2026-08-11T15:24:00.000Z',
      env: 'prod',
      status: 'deployed',
    })));
  });

  it('chooses Create experiment when release prerequisites are absent and previews the documented lifecycle', async () => {
    mockedStore.mockReturnValue({
      client: {
        releases: vi.fn().mockResolvedValue([]),
        decisions: vi.fn().mockResolvedValue([]),
        experiments: vi.fn().mockResolvedValue([]),
        contracts: vi.fn().mockResolvedValue([]),
      },
      project: 'alpha',
      env: 'prod',
    } as never);

    render(<MemoryRouter><Changes /></MemoryRouter>);

    expect(await screen.findByRole('link', { name: 'Create experiment' })).toHaveAttribute('href', '/experiments');
    expect(screen.queryByRole('button', { name: 'Register release' })).not.toBeInTheDocument();
    const preview = screen.getByRole('region', { name: 'Release decision loop documentation preview' });
    expect(preview).toHaveTextContent('Documentation preview');
    expect(preview).toHaveTextContent('poolstatis.yml');
    expect(within(preview).getAllByRole('listitem')).toHaveLength(5);
    expect(preview).toHaveTextContent('Register release');
    expect(preview).toHaveTextContent('Human decision');
  });

  it('shows the active release blocker, frozen owner, and expected decision date', async () => {
    const proposed = decision('proposed');
    const detail = decisionDetail(proposed);
    detail.release.next_evaluation_at = '2026-08-12T10:00:00.000Z';
    const blockedDetail = {
      ...detail,
      evidence: {
        ...detail.evidence,
        ready: false,
        blockers: [{
          code: 'minimum_sample',
          message: 'Only 45 of 50 required actors are available.',
          next_action: 'Wait for five more actors.',
        }],
      },
    };
    mockedStore.mockReturnValue({
      client: {
        releases: vi.fn().mockResolvedValue([detail.release]),
        decisions: vi.fn().mockResolvedValue([proposed]),
        experiments: vi.fn().mockResolvedValue([]),
        contracts: vi.fn().mockResolvedValue([]),
        decision: vi.fn().mockResolvedValue(blockedDetail),
      },
      project: 'alpha',
      env: 'prod',
    } as never);

    render(<MemoryRouter><Changes /></MemoryRouter>);

    const row = await screen.findByRole('article', { name: 'Shorter activation' });
    expect(within(row).getByText('Only 45 of 50 required actors are available.')).toBeInTheDocument();
    expect(within(row).getByText('growth-team')).toBeInTheDocument();
    expect(within(row).getAllByText(/Aug 12, 2026/).length).toBeGreaterThan(0);
  });

  it('evaluates the first eligible release from the guided decision queue', async () => {
    const eligible = release('observing');
    const evaluateRelease = vi.fn().mockResolvedValue({});
    const releases = vi.fn().mockResolvedValue([eligible]);
    mockedStore.mockReturnValue({
      client: {
        decisions: vi.fn().mockResolvedValue([]),
        releases,
        evaluateRelease,
        decisionInbox: vi.fn().mockResolvedValue([]),
        decisionHistory: vi.fn().mockResolvedValue({ items: [], next_cursor: null }),
        webhookDeliveries: vi.fn().mockResolvedValue([]),
        accountMode: vi.fn().mockResolvedValue(hostedOwnerMode),
      },
      project: 'alpha',
      env: 'prod',
    } as never);

    render(<MemoryRouter><Decisions /></MemoryRouter>);
    expect(await screen.findByText('Create the first reviewable decision')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open release in Ship' })).toHaveAttribute('href', `/changes?release=${eligible.id}`);
    fireEvent.click(screen.getByRole('button', { name: 'Evaluate eligible release' }));
    await waitFor(() => expect(evaluateRelease).toHaveBeenCalledWith('alpha', eligible.id));
    expect(releases).toHaveBeenCalledWith('alpha', { env: 'prod', decision_eligible: 'nearest' });
  });
});
