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
});
