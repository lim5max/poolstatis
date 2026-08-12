import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { Experiment } from '../api/types';
import { useStore } from '../store';
import { Experiments } from './Experiments';

vi.mock('../store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../store')>()),
  useStore: vi.fn(),
}));

const mockedStore = vi.mocked(useStore);

describe('Experiments lifecycle handoff', () => {
  it('links the same experiment identity into Ship and Decisions without copying status', async () => {
    const experiment: Experiment = {
      id: 'experiment-1',
      key: 'shorter_signup',
      name: 'Shorter signup',
      hypothesis: 'A shorter signup should improve completed activation.',
      flag_key: 'shorter_signup_flag',
      primary_metric_key: 'activation_completed',
      secondary_metric_keys: ['checkout_errors'],
      env: 'prod',
      control_variant_key: 'control',
      snapshot_integrity: 'frozen_at_start',
      status: 'running',
      started_at: '2026-08-10T10:00:00.000Z',
      concluded_at: null,
      decision: null,
      created_at: '2026-08-10T09:00:00.000Z',
      updated_at: '2026-08-10T10:00:00.000Z',
    };
    mockedStore.mockReturnValue({
      client: {
        flags: vi.fn().mockResolvedValue([]),
        experiments: vi.fn().mockResolvedValue([experiment]),
        metrics: vi.fn().mockResolvedValue([]),
        monitorPolicies: vi.fn().mockResolvedValue([]),
        monitorFindings: vi.fn().mockResolvedValue([]),
        automationProposals: vi.fn().mockResolvedValue([]),
      },
      project: 'alpha', env: 'prod',
    } as never);

    render(<MemoryRouter><Experiments /></MemoryRouter>);

    const card = await screen.findByRole('article', { name: 'Shorter signup' });
    expect(within(card).getByRole('link', { name: 'Open in Ship' }))
      .toHaveAttribute('href', '/changes?experiment=shorter_signup');
    expect(within(card).getByRole('link', { name: 'Open in Decisions' }))
      .toHaveAttribute('href', '/decisions?experiment=shorter_signup');
    expect(within(card).getByText('Running')).toBeInTheDocument();
  });

  it('shows only explicitly targeted monitor evidence and keeps a pause proposal non-executing', async () => {
    const experiment: Experiment = {
      id: 'experiment-1', key: 'shorter_signup', name: 'Shorter signup',
      hypothesis: 'A shorter signup should improve completed activation.',
      flag_key: 'shorter_signup_flag', primary_metric_key: 'activation_completed',
      secondary_metric_keys: ['checkout_errors'], env: 'prod', control_variant_key: 'control',
      snapshot_integrity: 'frozen_at_start', status: 'running', started_at: '2026-08-10T10:00:00.000Z',
      concluded_at: null, decision: null, created_at: '2026-08-10T09:00:00.000Z', updated_at: '2026-08-10T10:00:00.000Z',
    };
    mockedStore.mockReturnValue({
      client: {
        flags: vi.fn().mockResolvedValue([]), experiments: vi.fn().mockResolvedValue([experiment]), metrics: vi.fn().mockResolvedValue([]),
        monitorPolicies: vi.fn().mockResolvedValue([
          {
            id: 'policy-1', policy_key: 'signup_guardrail', name: 'Signup guardrail', current_version: 1,
            status: 'active', next_evaluation_at: '2026-08-12T11:00:00.000Z',
            revision: {
              metric_key: 'activation_completed', env: 'prod', target_kind: 'experiment', target_id: 'experiment-1',
              comparison_rule: 'change_down_percent', threshold: 20, minimum_sample: 100, window_minutes: 1440,
              cadence_minutes: 60, cooldown_seconds: 3600, owner: 'growth-team', destination_ids: [],
              proposal_kind: 'pause', proposal_target: { flag_key: 'shorter_signup_flag' }, version: 1,
            },
          },
          {
            id: 'policy-other', policy_key: 'other', name: 'Other policy', current_version: 1,
            status: 'active', next_evaluation_at: '2026-08-12T11:00:00.000Z',
            revision: {
              metric_key: 'activation_completed', env: 'prod', target_kind: 'experiment', target_id: 'experiment-other',
              comparison_rule: 'below', threshold: 10, minimum_sample: 10, window_minutes: 60,
              cadence_minutes: 60, cooldown_seconds: 3600, owner: 'other-team', destination_ids: [],
              proposal_kind: null, proposal_target: null, version: 1,
            },
          },
        ]),
        monitorFindings: vi.fn().mockResolvedValue([{ id: 'finding-1', policy_id: 'policy-1', policy_key: 'signup_guardrail', policy_name: 'Signup guardrail', severity: 'warning', snapshot: {}, evidence: {}, notification_state: 'queued', created_at: '2026-08-12T10:00:00.000Z' }]),
        automationProposals: vi.fn().mockResolvedValue([{ id: 'proposal-1', policy_id: 'policy-1', finding_id: 'finding-1', kind: 'pause', status: 'proposed', target: {}, payload: {}, undo: {}, confirmation_fingerprint: 'abc', review_rationale: null, created_at: '2026-08-12T10:00:00.000Z' }]),
      }, project: 'alpha', env: 'prod',
    } as never);

    render(<MemoryRouter><Experiments /></MemoryRouter>);

    const card = await screen.findByRole('article', { name: 'Shorter signup' });
    const monitoring = within(card).getByRole('region', { name: 'Experiment monitoring' });
    expect(within(monitoring).getByText('Signup guardrail')).toBeInTheDocument();
    expect(within(monitoring).queryByText('Other policy')).not.toBeInTheDocument();
    expect(within(monitoring).getByText(/pause proposal/)).toBeInTheDocument();
    expect(within(monitoring).getByText(/has not changed traffic/)).toBeInTheDocument();
    expect(within(monitoring).getByRole('link', { name: 'Open control tower' })).toHaveAttribute('href', '/control-tower');
  });
});
