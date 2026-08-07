import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../store';
import { Usage, usageMonthPresetRange } from './Usage';

vi.mock('../store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../store')>()),
  useStore: vi.fn(),
}));

const mockedStore = vi.mocked(useStore);
const usage = vi.fn();
const usageActivity = vi.fn();
const usageRange = vi.fn();

function monthOffset(offset: number): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1)).toISOString().slice(0, 7);
}

function rangeResponse(from: string, to: string) {
  return {
    meter: 'events_stored', from, to, timezone: 'UTC', granularity: 'month', usage_basis: 'ingest_time', quantity: '7',
    current_entitlement: {
      period: monthOffset(0), hard_limit: 100, warning_thresholds: [80], basis: 'current_configuration',
    },
    periods: [{
      period: from, quantity: '7', unattributed_quantity: '2', warnings: [],
      projects: [{ id: 'project-1', slug: 'alpha', name: 'Alpha', quantity: '5', environments: [{ env: 'prod', quantity: '5' }] }],
    }],
  };
}

describe('Usage month range', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    usage.mockResolvedValue({
      meter: 'events_stored', period: monthOffset(0), quantity: 7, hard_limit: 100,
      warning_thresholds: [80], warnings: [], projects: [],
    });
    usageActivity.mockResolvedValue({
      meter: 'events_stored', date_from: '2026-08-01', date_to: '2026-08-07', quantity: '7',
      source: 'usage_ledger', timezone: 'UTC', projects: [],
    });
    usageRange.mockImplementation(async (from: string, to: string) => rangeResponse(from, to));
    mockedStore.mockReturnValue({
      tokenKind: 'user', account: { membership: { role: 'owner' } },
      client: { usage, usageActivity, usageRange },
    } as never);
  });

  it('keeps UTC presets correct across a year boundary', () => {
    expect(usageMonthPresetRange('last', '2026-01')).toEqual({ from: '2025-12', to: '2025-12' });
    expect(usageMonthPresetRange('last-3', '2026-01')).toEqual({ from: '2025-11', to: '2026-01' });
    expect(usageMonthPresetRange('last-6', '2026-01')).toEqual({ from: '2025-08', to: '2026-01' });
  });

  it('defaults to the current UTC month and exposes current/last/3/6 month presets', async () => {
    render(<Usage />);

    await waitFor(() => expect(usageRange).toHaveBeenCalledWith(monthOffset(0), monthOffset(0)));
    expect(screen.getByRole('button', { name: 'Current month' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Last month' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Last 3 months' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Last 6 months' })).toBeInTheDocument();
    expect(screen.getByLabelText('Usage month from')).toHaveAttribute('type', 'month');
    expect(screen.getByLabelText('Usage month to')).toHaveAttribute('type', 'month');

    fireEvent.click(screen.getByRole('button', { name: 'Last 3 months' }));
    await waitFor(() => expect(usageRange).toHaveBeenLastCalledWith(monthOffset(-2), monthOffset(0)));
  });

  it('validates custom bounds before requesting and explains ledger attribution gaps', async () => {
    render(<Usage />);
    await waitFor(() => expect(usageRange).toHaveBeenCalledOnce());
    expect(await screen.findByText('2 events without retained project attribution')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Usage month from'), { target: { value: '2026-08' } });
    fireEvent.change(screen.getByLabelText('Usage month to'), { target: { value: '2026-07' } });

    expect(await screen.findByText('The start month must not be after the end month.')).toBeInTheDocument();
    expect(usageRange).toHaveBeenCalledOnce();
  });
});
