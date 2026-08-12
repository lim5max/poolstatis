import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { AccountMode } from '../api/types';
import { useStore } from '../store';
import { Decisions, decisionReviewAccess } from './Decisions';

vi.mock('../store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../store')>()),
  useStore: vi.fn(),
}));

const mockedStore = vi.mocked(useStore);

function accountMode({
  deployment = 'hosted', kind = 'user', role = 'owner', review = true,
}: {
  deployment?: 'hosted' | 'self_host';
  kind?: 'secret' | 'personal' | 'user';
  role?: 'owner' | 'admin' | 'member' | null;
  review?: boolean;
} = {}): AccountMode {
  return {
    schema_version: 1,
    deployment: {
      mode: deployment,
      hosted_account: deployment === 'hosted' ? 'available' : 'not_configured',
    },
    session: { kind, scope: kind === 'secret' ? 'project' : 'organization', role },
    capabilities: {
      portfolio: kind === 'secret' ? 'project_only' : 'available',
      compare_projects: kind !== 'secret',
      manage_profile: deployment === 'hosted' && kind === 'user',
      manage_personal_tokens: false,
      review_decisions: review,
      set_official_answers: false,
    },
    primary_action: deployment === 'hosted'
      ? { id: kind === 'user' ? 'manage_hosted_account' : 'sign_in_to_manage_account', kind: 'navigate', label: 'Manage account', href: '/profile' }
      : { id: 'open_local_setup', kind: 'navigate', label: 'Open local setup', href: '/setup' },
  };
}

function decision(id: string, proposedOutcome: 'keep' | 'rollback', updatedAt: string) {
  return {
    id,
    release_id: `release-${id}`,
    contract_id: `contract-${id}`,
    evidence_id: `evidence-${id}`,
    status: 'proposed',
    proposed_outcome: proposedOutcome,
    proposed_rationale: `Evidence-backed proposal for ${id}.`,
    accepted_outcome: null,
    accepted_rationale: null,
    current_revision: 1,
    created_by: 'agent',
    created_at: updatedAt,
    updated_at: updatedAt,
    queue_priority: {
      evidence_readiness: 'ready',
      risk: proposedOutcome === 'rollback' ? 'high' : 'low',
    },
  } as const;
}

describe('Decisions handoff', () => {
  it('keeps API keys and members read-only while allowing signed-in owner/admin review', () => {
    expect(decisionReviewAccess(accountMode({ kind: 'secret', role: null, review: false }))).toBe('sign_in_required');
    expect(decisionReviewAccess(accountMode({ kind: 'personal', role: 'owner', review: false }))).toBe('sign_in_required');
    expect(decisionReviewAccess(accountMode({ role: 'member', review: false }))).toBe('insufficient_role');
    expect(decisionReviewAccess(accountMode({ role: 'owner' }))).toBe('allowed');
    expect(decisionReviewAccess(accountMode({ role: 'admin' }))).toBe('allowed');
    expect(decisionReviewAccess(accountMode({ deployment: 'self_host', kind: 'personal', role: null }))).toBe('legacy_self_host');
    expect(decisionReviewAccess(null, true)).toBe('loading');
    expect(decisionReviewAccess(null, false, 'unavailable')).toBe('unavailable');
  });

  it('selects the exact proposal referenced by the funnel handoff', async () => {
    const client = {
      decisions: vi.fn().mockResolvedValue([
        decision('decision-newer', 'keep', '2026-08-06T12:00:00Z'),
        decision('decision-target', 'rollback', '2026-08-05T12:00:00Z'),
      ]),
      releases: vi.fn().mockResolvedValue([]),
      decision: vi.fn().mockReturnValue(new Promise(() => undefined)),
      decisionInbox: vi.fn().mockResolvedValue([]),
      decisionHistory: vi.fn().mockResolvedValue({ items: [], next_cursor: null }),
      webhookDeliveries: vi.fn().mockResolvedValue([]),
      accountMode: vi.fn().mockResolvedValue(accountMode()),
    };
    mockedStore.mockReturnValue({ client, project: 'alpha', env: 'prod' } as never);

    render(<MemoryRouter initialEntries={['/decisions?decision=decision-target']}><Decisions /></MemoryRouter>);

    const target = await screen.findByRole('button', { name: /Review: rollback/ });
    await waitFor(() => expect(target).toHaveAttribute('aria-pressed', 'true'));
    await waitFor(() => expect(client.decision).toHaveBeenCalledWith('alpha', 'decision-target'));

    const newer = screen.getByRole('button', { name: /Review: keep/ });
    fireEvent.click(newer);
    await waitFor(() => expect(newer).toHaveAttribute('aria-pressed', 'true'));
  });

  it('preserves the server-owned readiness, risk and age order', async () => {
    const serverFirst = decision('decision-risk-old', 'rollback', '2026-08-01T12:00:00Z');
    const clientNewer = decision('decision-low-new', 'keep', '2026-08-09T12:00:00Z');
    const client = {
      decisions: vi.fn().mockResolvedValue([serverFirst, clientNewer]),
      releases: vi.fn().mockResolvedValue([]),
      decision: vi.fn().mockReturnValue(new Promise(() => undefined)),
      decisionInbox: vi.fn().mockResolvedValue([]),
      decisionHistory: vi.fn().mockResolvedValue({ items: [], next_cursor: null }),
      webhookDeliveries: vi.fn().mockResolvedValue([]),
      accountMode: vi.fn().mockResolvedValue(accountMode()),
    };
    mockedStore.mockReturnValue({ client, project: 'alpha', env: 'prod' } as never);

    render(<MemoryRouter><Decisions /></MemoryRouter>);

    const rows = await screen.findAllByRole('button', { name: /Review:/ });
    expect(rows[0]).toHaveAccessibleName(/Review: rollback/);
    expect(rows[0]).toHaveTextContent('Ready evidence');
    expect(rows[0]).toHaveTextContent('High risk');
  });

  it('keeps an experiment handoff scoped to the same server identity', async () => {
    const decisions = vi.fn().mockResolvedValue([]);
    const releases = vi.fn().mockResolvedValue([]);
    const client = {
      decisions,
      releases,
      decisionInbox: vi.fn().mockResolvedValue([]),
      decisionHistory: vi.fn().mockResolvedValue({ items: [], next_cursor: null }),
      webhookDeliveries: vi.fn().mockResolvedValue([]),
      accountMode: vi.fn().mockResolvedValue(accountMode()),
    };
    mockedStore.mockReturnValue({ client, project: 'alpha', env: 'prod' } as never);

    render(<MemoryRouter initialEntries={['/decisions?experiment=shorter_signup']}><Decisions /></MemoryRouter>);

    expect(await screen.findByText('Create the first reviewable decision')).toBeInTheDocument();
    expect(decisions).toHaveBeenCalledWith('alpha', { env: 'prod', experiment_key: 'shorter_signup' });
    expect(releases).toHaveBeenCalledWith('alpha', {
      env: 'prod', experiment_key: 'shorter_signup', decision_eligible: 'nearest',
    });
    expect(screen.getByRole('link', { name: 'Open experiment in Ship' }))
      .toHaveAttribute('href', '/changes?experiment=shorter_signup');
  });
});
