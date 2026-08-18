import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../store';
import { Person } from './Person';

vi.mock('../store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../store')>()),
  useStore: vi.fn(),
}));

const personSummary = vi.fn();
const mockedStore = vi.mocked(useStore);

describe('Person profile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    personSummary.mockResolvedValue({
      requested_distinct_id: 'actor-7',
      distinct_id: 'actor-7',
      env: 'prod',
      window: { from: '2026-07-07T00:00:00Z', to: '2026-08-06T00:00:00Z' },
      summary: {
        first_seen: '2026-08-01T10:00:00Z', last_seen: '2026-08-05T11:00:00Z',
        total_events: 12, distinct_events: 2, active_days: 3, sessions: 2, session_count: 2,
        registered_share: 1, top_events: [{ event: 'page.viewed', count: 8 }],
      },
      identity: {
        status: 'unknown', raw_actor_count: 1, raw_distinct_ids: ['actor-7'],
        raw_distinct_ids_truncated: false, links: [], links_truncated: false,
      },
      entity: null,
      activity: { events: [], next_cursor: null, registered_only: true, properties_masked: true },
      capabilities: {
        identity_entity: { available: false, reason: 'No identity entity.', source: null },
        activity_properties: { available: false, reason: 'Properties are masked.', source: null },
        pinned_properties: { available: false, reason: 'No pinned properties.', source: null },
        session_count: { source: 'canonical_browser_sessions', unavailable_value: null, project_capability: true },
        purge: { scope: 'exact_raw_distinct_id', canonical_expansion: false, warning: 'Exact raw ID only.' },
      },
    });
    mockedStore.mockReturnValue({
      project: 'alpha', env: 'prod', client: { personSummary },
    } as never);
  });

  it('uses the shared custom period and a compact readable profile', async () => {
    const view = render(
      <MemoryRouter initialEntries={['/analyze/users/actor-7']}>
        <Routes><Route path="/analyze/users/:distinctId" element={<Person />} /></Routes>
      </MemoryRouter>,
    );
    await screen.findByRole('heading', { name: 'Actor profile' });

    const period = screen.getByRole('group', { name: 'Analytics period' });
    fireEvent.click(period.querySelector('button:last-child')!);
    fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '2026-08-01' } });
    fireEvent.change(screen.getByLabelText('End date'), { target: { value: '2026-08-04' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply period' }));

    await waitFor(() => expect(personSummary).toHaveBeenLastCalledWith('alpha', 'actor-7', expect.objectContaining({
      env: 'prod', from: '2026-08-01T00:00:00.000Z', to: '2026-08-05T00:00:00.000Z',
    })));
    expect(screen.queryByText('Last 30 days')).not.toBeInTheDocument();
    expect(view.container.querySelector('.text-xs')).toBeNull();
  });
});
