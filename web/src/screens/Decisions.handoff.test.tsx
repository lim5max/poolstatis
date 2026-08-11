import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { useStore } from '../store';
import { Decisions } from './Decisions';

vi.mock('../store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../store')>()),
  useStore: vi.fn(),
}));

const mockedStore = vi.mocked(useStore);

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
  } as const;
}

describe('Decisions handoff', () => {
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
    };
    mockedStore.mockReturnValue({ client, project: 'alpha', env: 'prod' } as never);

    render(<MemoryRouter initialEntries={['/decisions?decision=decision-target']}><Decisions /></MemoryRouter>);

    const target = await screen.findByRole('button', { name: /Review: rollback/ });
    await waitFor(() => expect(target).toHaveAttribute('aria-pressed', 'true'));
    expect(client.decision).toHaveBeenCalledWith('alpha', 'decision-target');

    const newer = screen.getByRole('button', { name: /Review: keep/ });
    fireEvent.click(newer);
    await waitFor(() => expect(newer).toHaveAttribute('aria-pressed', 'true'));
  });
});
