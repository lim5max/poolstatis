import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../store';
import { Usage, usageMonthPresetRange } from './Usage';

vi.mock('../store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../store')>()),
  useStore: vi.fn(),
}));

const mockedStore = vi.mocked(useStore);
const usage = vi.fn();
const usageControl = vi.fn();
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
    usageControl.mockResolvedValue({
      schema_version: 1,
      request_id: 'usage-control-request',
      generated_at: '2026-08-10T12:00:00.000Z',
      scope: {
        organization_id: 'org-1',
        window: { from: '2026-08-01T00:00:00.000Z', to: '2026-08-31T23:59:59.999Z', timezone: 'UTC' },
      },
      answer: {
        state: 'partial',
        headline: '620 accepted events this UTC cycle',
        takeaway: '380 events remain before the configured hard limit.',
        primary_value: { value: 620, unit: 'count', formatted: '620' },
        why_it_matters: 'Accepted-event continuity determines whether product answers remain complete.',
      },
      attention: [],
      evidence: {
        state: 'trusted',
        as_of: '2026-08-10T12:00:00.000Z',
        freshness: 'fresh',
        source_refs: [{ kind: 'usage_ledger', meter: 'events_stored' }],
        sample: { eligible: 7, observed: 3, coverage: 3 / 7 },
        warnings: [],
        unavailable_reasons: [],
      },
      primary_action: { id: 'review_usage_contributors', kind: 'navigate', label: 'Review usage contributors', href: '/usage' },
      secondary_actions: [],
      meter: 'events_stored',
      cycle: { from: '2026-08-01T00:00:00.000Z', to: '2026-08-31T23:59:59.999Z', timezone: 'UTC' },
      cap: { state: 'finite', value: 1_000, remaining: 380, consequence_at_100_percent: 'New accepted-event writes are rejected.' },
      pace: { observed_days: 3, events_per_day_7d: 62, projected_cycle_end: 1_922, confidence: 'sufficient' },
      threshold_forecasts: [
        { percent: 50, state: 'reached', reached_or_projected_at: '2026-08-09T00:00:00.000Z', notification_state: 'not_configured', audit_source: 'usage_ledger' },
        { percent: 75, state: 'projected', reached_or_projected_at: '2026-08-13T00:00:00.000Z', notification_state: 'not_configured', audit_source: 'usage_ledger' },
        { percent: 90, state: 'projected', reached_or_projected_at: '2026-08-15T00:00:00.000Z', notification_state: 'not_configured', audit_source: 'usage_ledger' },
        { percent: 100, state: 'projected', reached_or_projected_at: '2026-08-17T00:00:00.000Z', notification_state: 'not_configured', audit_source: 'usage_ledger' },
      ],
      contributors: [{
        project_slug: 'alpha', project_name: 'Alpha', environment: 'prod', accepted_events: 620,
        share: 1, change_7d: 0.25, last_ingest_at: '2026-08-10T11:00:00.000Z',
      }],
    });
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
      client: { usage, usageControl, usageActivity, usageRange },
    } as never);
  });

  it('renders pace, forecast and contributors from the server-owned usage contract', async () => {
    render(<Usage />);

    expect(await screen.findByText('620 accepted events this UTC cycle')).toBeInTheDocument();
    expect(screen.getByText('62 / day')).toBeInTheDocument();
    expect(screen.getByText('1,922')).toBeInTheDocument();
    expect(screen.getByText('+25%')).toBeInTheDocument();
    expect(screen.getAllByText('Projected Aug 17, 2026')).toHaveLength(2);
    expect(screen.getAllByText('Notification: Not configured')).toHaveLength(4);
    expect(screen.getAllByText('Audit: usage ledger')).toHaveLength(4);
    expect(usageControl).toHaveBeenCalledOnce();
    expect(usageControl).toHaveBeenCalledWith(monthOffset(0));
    expect(usage).not.toHaveBeenCalled();
  });

  it('keeps UTC presets correct across a year boundary', () => {
    expect(usageMonthPresetRange('last', '2026-01')).toEqual({ from: '2025-12', to: '2025-12' });
    expect(usageMonthPresetRange('last-3', '2026-01')).toEqual({ from: '2025-11', to: '2026-01' });
    expect(usageMonthPresetRange('last-6', '2026-01')).toEqual({ from: '2025-08', to: '2026-01' });
  });

  it('shows an honest no-cap state instead of a full or unlimited meter', async () => {
    const base = await usageControl();
    usageControl.mockClear();
    usageControl.mockResolvedValue({
      ...base,
      answer: {
        ...base.answer,
        headline: '620 accepted events this UTC cycle',
        takeaway: 'No Core hard limit is configured for this organization.',
      },
      cap: { state: 'not_configured', value: null, remaining: null, consequence_at_100_percent: null },
      threshold_forecasts: base.threshold_forecasts.map((threshold: { percent: number }) => ({
        percent: threshold.percent,
        state: 'not_applicable',
        reached_or_projected_at: null,
        notification_state: 'not_configured',
        audit_source: 'usage_ledger',
      })),
    });

    render(<Usage />);

    expect(await screen.findByText('No hard cap configured')).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.getByText(/not shown as unlimited/)).toBeInTheDocument();
  });

  it('uses self-hosted usage actions without implying a hosted plan mutation', async () => {
    mockedStore.mockReturnValue({
      tokenKind: 'personal', account: null,
      client: {
        usageControl, usageActivity, usageRange,
        accountMode: vi.fn().mockResolvedValue({
          deployment: { mode: 'self_host', hosted_account: 'not_configured' },
          primary_action: { id: 'open_local_setup', kind: 'navigate', label: 'Open local setup', href: '/setup' },
        }),
      },
    } as never);

    render(<MemoryRouter><Usage /></MemoryRouter>);

    expect(await screen.findByRole('link', { name: 'Configure cap' })).toHaveAttribute('href', '/setup');
    expect(screen.getByRole('button', { name: 'Review contributors' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Review plan' })).not.toBeInTheDocument();
  });

  it('defaults to the current UTC month and exposes current/last/3/6 month presets', async () => {
    render(<Usage />);

    fireEvent.click(screen.getByText('Historical ledger and custom ranges'));
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
    fireEvent.click(screen.getByText('Historical ledger and custom ranges'));
    await waitFor(() => expect(usageRange).toHaveBeenCalledOnce());
    expect(await screen.findByText('2 events without retained project attribution')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Usage month from'), { target: { value: '2026-08' } });
    fireEvent.change(screen.getByLabelText('Usage month to'), { target: { value: '2026-07' } });

    expect(await screen.findByText('The start month must not be after the end month.')).toBeInTheDocument();
    expect(usageRange).toHaveBeenCalledOnce();
  });
});
