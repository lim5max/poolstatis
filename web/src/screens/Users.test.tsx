import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../store';
import { Users } from './Users';

vi.mock('../store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../store')>()),
  useStore: vi.fn(),
}));

const mockedStore = vi.mocked(useStore);

describe('People list', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedStore.mockReturnValue({
      project: 'alpha', env: 'prod',
      client: {
        metrics: vi.fn().mockResolvedValue([]),
        operationalQuery: vi.fn().mockResolvedValue({
          kind: 'actors',
          actors: [{
            distinct_id: 'anon_7', raw_actor_count: 1,
            first_seen: '2026-08-01T00:00:00Z', last_seen: '2026-08-05T00:00:00Z',
            total_events: 4, active_days: 2, session_count: null,
            top_events: [{ event: 'page.viewed', count: 4 }], pinned_properties: {}, identity_status: 'anonymous',
            interesting_score: 406, rank_reasons: ['recently_observed'],
          }],
          meta: { next_cursor: null },
        }),
      },
    } as never);
  });

  it('uses honest anonymous, outcome and session states while keeping properties redacted', async () => {
    render(<MemoryRouter><Users /></MemoryRouter>);

    expect(await screen.findByRole('heading', { name: 'People', level: 1 })).toBeInTheDocument();
    expect(screen.getByText('Anonymous')).toBeInTheDocument();
    expect(screen.getByText('Not assessed')).toBeInTheDocument();
    expect(screen.getByText('Unavailable')).toBeInTheDocument();
    expect(screen.getByText('Recently first observed')).toBeInTheDocument();
    expect(screen.getByText(/does not infer risk/)).toBeInTheDocument();
    expect(screen.getByText(/Activity properties remain redacted/)).toBeInTheDocument();
  });
});
