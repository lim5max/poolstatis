import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../store';
import { parseUsageEntitlementForm, Usage, usageMonthPresetRange } from './Usage';
import { ApiError } from '../api/client';

vi.mock('../store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../store')>()),
  useStore: vi.fn(),
}));

const mockedStore = vi.mocked(useStore);
const usage = vi.fn();
const usageControl = vi.fn();
const usageActivity = vi.fn();
const usageRange = vi.fn();
const usageEntitlement = vi.fn();
const configureUsageEntitlement = vi.fn();
const setProject = vi.fn();

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
  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
  });

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
        { percent: 50, state: 'reached', reached_or_projected_at: '2026-08-09T00:00:00.000Z', configured_threshold: null, notification_state: 'not_configured', audit_source: 'usage_ledger' },
        { percent: 75, state: 'projected', reached_or_projected_at: '2026-08-13T00:00:00.000Z', configured_threshold: null, notification_state: 'not_configured', audit_source: 'usage_ledger' },
        { percent: 90, state: 'projected', reached_or_projected_at: '2026-08-15T00:00:00.000Z', configured_threshold: null, notification_state: 'not_configured', audit_source: 'usage_ledger' },
        { percent: 100, state: 'projected', reached_or_projected_at: '2026-08-17T00:00:00.000Z', configured_threshold: null, notification_state: 'not_configured', audit_source: 'usage_ledger' },
      ],
      contributors: [{
        project_slug: 'alpha', project_name: 'Alpha', environment: 'prod', accepted_events: 620,
        share: 1, change_7d: 0.25, last_ingest_at: '2026-08-10T11:00:00.000Z',
      }],
      reconciliation: {
        metered_quantity: 620,
        attributed_quantity: 620,
        difference: 0,
        unattributed_quantity: 0,
        overattributed_quantity: 0,
        state: 'reconciled',
      },
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
      setProject,
      client: { usage, usageControl, usageActivity, usageRange },
    } as never);
  });

  it('renders pace, forecast and contributors from the server-owned usage contract', async () => {
    render(<MemoryRouter><Usage /></MemoryRouter>);

    expect(await screen.findByTestId('usage-current-quantity')).toHaveTextContent('620');
    expect(screen.getByText('accepted events')).toBeInTheDocument();
    expect(screen.getByText('62 / day')).toBeInTheDocument();
    expect(screen.getByText('7-day moving average')).toBeInTheDocument();
    expect(screen.getByText(/As of Aug 10, 2026/)).toBeInTheDocument();
    expect(screen.getByText(/3 of 7 calendar days with accepted events/)).toBeInTheDocument();
    expect(screen.getByText('1,922')).toBeInTheDocument();
    expect(screen.getByText('+25%')).toBeInTheDocument();
    expect(screen.getAllByText('Projected Aug 17, 2026')).toHaveLength(2);
    expect(screen.getAllByText('Record: Not configured')).toHaveLength(4);
    expect(screen.getAllByText('Source: usage ledger')).toHaveLength(4);
    const projectLink = screen.getByRole('link', { name: 'Open Alpha project health in prod' });
    expect(projectLink).toHaveAttribute('href', '/projects?project=alpha&env=prod');
    fireEvent.click(projectLink);
    expect(setProject).toHaveBeenCalledWith('alpha', 'prod');
    expect(usageControl).toHaveBeenCalledOnce();
    expect(usageControl).toHaveBeenCalledWith(monthOffset(0));
    expect(usage).not.toHaveBeenCalled();
  });

  it('surfaces current-cycle quantity that is not reconciled to retained contributors', async () => {
    const base = await usageControl();
    usageControl.mockClear();
    usageControl.mockResolvedValue({
      ...base,
      evidence: {
        ...base.evidence,
        state: 'partial',
        warnings: [{
          code: 'ledger_attribution_gap',
          message: 'Current projection is 620, while retained contributor ledger facts total 600.',
          remediation_action_id: 'review_usage_contributors',
        }],
      },
      contributors: [{ ...base.contributors[0], accepted_events: 600, share: 600 / 620 }],
      reconciliation: {
        metered_quantity: 620,
        attributed_quantity: 600,
        difference: 20,
        unattributed_quantity: 20,
        overattributed_quantity: 0,
        state: 'partial',
      },
    });

    render(<MemoryRouter><Usage /></MemoryRouter>);

    expect(await screen.findByText('20 accepted events are not reconciled to retained project and environment contributors.')).toBeInTheDocument();
    expect(screen.getByText('600 of 620 events attributed')).toBeInTheDocument();
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
        configured_threshold: null,
        notification_state: 'not_configured',
        audit_source: 'usage_ledger',
      })),
    });

    render(<MemoryRouter><Usage /></MemoryRouter>);

    expect(await screen.findByText('No hard cap configured')).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.getByText('Metered only · no maximum implied')).toBeInTheDocument();
  });

  it('uses self-hosted usage actions without implying a hosted plan mutation', async () => {
    usageEntitlement.mockResolvedValue({
      schema_version: 1,
      meter: 'events_stored',
      revision: 1,
      hard_limit: 1_000,
      warning_thresholds: [500, 750, 900, 1_000],
      current_usage: 620,
      remaining: 380,
      changed: false,
      consequences: {
        scope: 'organization_all_projects_and_environments',
        cap_enforcement: 'accepted_batches_exceeding_cap_are_rejected',
        threshold_recording: 'crossings_recorded_in_core_without_external_delivery',
        effective_cycle: monthOffset(0),
      },
      audit: { source: 'usage_entitlement_revisions', latest: null },
    });
    configureUsageEntitlement.mockResolvedValue({});
    mockedStore.mockReturnValue({
      tokenKind: 'personal', account: null,
      client: {
        usageControl, usageActivity, usageRange, usageEntitlement, configureUsageEntitlement,
        accountMode: vi.fn().mockResolvedValue({
          deployment: { mode: 'self_host', hosted_account: 'not_configured' },
          capabilities: {
            configure_usage_entitlement: 'available', review_plan: 'unavailable', set_usage_alert: 'unavailable',
          },
          primary_action: { id: 'open_local_setup', kind: 'navigate', label: 'Open local setup', href: '/setup' },
        }),
      },
    } as never);

    render(<MemoryRouter><Usage /></MemoryRouter>);

    fireEvent.click(await screen.findByRole('button', { name: 'Configure cap' }));
    expect(await screen.findByRole('dialog')).toHaveTextContent('no email or webhook is delivered');
    fireEvent.change(screen.getByLabelText('Hard limit'), { target: { value: '1200' } });
    fireEvent.click(screen.getByRole('button', { name: 'Use 50 / 75 / 90 / 100%' }));
    fireEvent.click(screen.getByRole('button', { name: 'Apply configuration' }));
    await waitFor(() => expect(configureUsageEntitlement).toHaveBeenCalledWith({
      expected_revision: 1,
      hard_limit: 1200,
      warning_thresholds: [600, 900, 1080, 1200],
      reason: 'Update self-host usage protection from the Usage page.',
    }));
    expect(await screen.findByRole('button', { name: 'Review contributors' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Review plan' })).not.toBeInTheDocument();
  });

  it('reloads and rebases the form after an entitlement revision conflict', async () => {
    const revisionOne = {
      schema_version: 1 as const,
      meter: 'events_stored' as const,
      revision: 1,
      hard_limit: 1_000,
      warning_thresholds: [500, 750, 900, 1_000],
      current_usage: 620,
      remaining: 380,
      changed: false,
      consequences: {
        scope: 'organization_all_projects_and_environments' as const,
        cap_enforcement: 'accepted_batches_exceeding_cap_are_rejected' as const,
        threshold_recording: 'crossings_recorded_in_core_without_external_delivery' as const,
        effective_cycle: monthOffset(0),
      },
      audit: { source: 'usage_entitlement_revisions' as const, latest: null },
    };
    const revisionTwo = {
      ...revisionOne,
      revision: 2,
      hard_limit: 1_400,
      remaining: 780,
      audit: {
        source: 'usage_entitlement_revisions' as const,
        latest: {
          revision: 2,
          actor_kind: 'personal_token' as const,
          reason: 'Concurrent owner adjustment.',
          created_at: '2026-08-12T00:00:00.000Z',
        },
      },
    };
    usageEntitlement.mockResolvedValueOnce(revisionOne).mockResolvedValue(revisionTwo);
    configureUsageEntitlement
      .mockRejectedValueOnce(new ApiError(
        'usage_entitlement_revision_conflict',
        'the usage entitlement changed after it was read',
        undefined,
        409,
      ))
      .mockResolvedValueOnce(revisionTwo);
    mockedStore.mockReturnValue({
      tokenKind: 'personal', account: null,
      client: {
        usageControl, usageActivity, usageRange, usageEntitlement, configureUsageEntitlement,
        accountMode: vi.fn().mockResolvedValue({
          deployment: { mode: 'self_host', hosted_account: 'not_configured' },
          capabilities: {
            configure_usage_entitlement: 'available', review_plan: 'unavailable', set_usage_alert: 'unavailable',
          },
          primary_action: { id: 'open_local_setup', kind: 'navigate', label: 'Open local setup', href: '/setup' },
        }),
      },
    } as never);

    render(<MemoryRouter><Usage /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: 'Configure cap' }));
    fireEvent.change(screen.getByLabelText('Hard limit'), { target: { value: '1200' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply configuration' }));

    expect(await screen.findByText('Configuration changed elsewhere. Current values were reloaded; review and apply again.')).toBeInTheDocument();
    expect(screen.getByLabelText('Hard limit')).toHaveValue('1400');
    expect(screen.getByText('Last change · revision 2 · Concurrent owner adjustment.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Hard limit'), { target: { value: '1500' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply configuration' }));
    await waitFor(() => expect(configureUsageEntitlement).toHaveBeenLastCalledWith(expect.objectContaining({
      expected_revision: 2,
      hard_limit: 1500,
    })));
  });

  it('renders unavailable entitlement evidence without claiming enforcement is off', async () => {
    const base = await usageControl();
    usageControl.mockResolvedValue({
      ...base,
      answer: {
        state: 'unavailable', headline: 'Usage unavailable', takeaway: 'No trustworthy usage result is available.',
        primary_value: null, why_it_matters: 'Usage evidence must be reloaded.',
      },
      evidence: { ...base.evidence, state: 'unavailable', freshness: 'unknown' },
      cap: { state: 'unavailable', value: null, remaining: null, consequence_at_100_percent: null },
    });

    render(<MemoryRouter><Usage /></MemoryRouter>);

    expect(await screen.findByText('Entitlement unavailable')).toBeInTheDocument();
    const enforcementHelp = screen.getByText('Usage entitlement evidence is unavailable, so enforcement state is unknown.');
    expect(enforcementHelp).not.toBeVisible();
    fireEvent.click(screen.getByLabelText('About usage enforcement'));
    expect(enforcementHelp).toBeVisible();
    expect(screen.getByText('Usage response could not be verified.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry usage' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.queryByText('No hard cap configured')).not.toBeInTheDocument();
    expect(screen.queryByText('Enforcement is off; accepted events continue to be metered.')).not.toBeInTheDocument();
    expect(screen.queryByText('No events')).not.toBeInTheDocument();
    expect(screen.queryByText('0 of 0 events attributed')).not.toBeInTheDocument();
    expect(screen.queryByText('No cap · inactive')).not.toBeInTheDocument();
    expect(screen.queryByText('Hard-limit consequence is not configured.')).not.toBeInTheDocument();
  });

  it('shows hosted plan and delivered alerts as unavailable without fake actions', async () => {
    mockedStore.mockReturnValue({
      tokenKind: 'user', account: { membership: { role: 'owner' } },
      client: {
        usageControl, usageActivity, usageRange,
        accountMode: vi.fn().mockResolvedValue({
          deployment: { mode: 'hosted', hosted_account: 'available' },
          capabilities: {
            configure_usage_entitlement: 'unavailable_hosted', review_plan: 'unavailable', set_usage_alert: 'unavailable',
          },
          primary_action: { id: 'manage_hosted_account', kind: 'navigate', label: 'Manage account', href: 'https://auth.poolstatis.xyz/profile' },
        }),
      },
    } as never);

    render(<MemoryRouter><Usage /></MemoryRouter>);

    const usageHelp = await screen.findByText('Usage counts accepted events from the immutable UTC ledger. Forecasts are estimates; plan changes and delivered alerts remain outside Core.');
    expect(usageHelp).not.toBeVisible();
    fireEvent.click(screen.getByLabelText('About Usage'));
    expect(usageHelp).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Review plan' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Set alert' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Configure cap' })).not.toBeInTheDocument();
  });

  it('validates cap and recorded-threshold consequences before writing', () => {
    expect(parseUsageEntitlementForm({ hardLimit: '619', thresholds: '', currentUsage: 620 }))
      .toEqual({ error: 'Hard limit cannot be below current usage (620).' });
    expect(parseUsageEntitlementForm({ hardLimit: '1000', thresholds: '900, 800', currentUsage: 620 }))
      .toEqual({ error: 'Recorded thresholds must be unique and strictly ascending.' });
    expect(parseUsageEntitlementForm({ hardLimit: '', thresholds: '800', currentUsage: 620 }))
      .toEqual({ hard_limit: null, warning_thresholds: [800] });
  });

  it('avoids smooth scrolling when reduced motion is requested', async () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });
    vi.spyOn(window, 'matchMedia').mockReturnValue({
      matches: true,
      media: '(prefers-reduced-motion: reduce)',
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    });

    render(<MemoryRouter><Usage /></MemoryRouter>);

    fireEvent.click(await screen.findByRole('button', { name: 'Review contributors' }));
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'auto', block: 'start' });
  });

  it('defaults to the current UTC month and exposes current/last/3/6 month presets', async () => {
    render(<MemoryRouter><Usage /></MemoryRouter>);

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
    render(<MemoryRouter><Usage /></MemoryRouter>);
    fireEvent.click(screen.getByText('Historical ledger and custom ranges'));
    await waitFor(() => expect(usageRange).toHaveBeenCalledOnce());
    expect(await screen.findByText('2 events without retained project attribution')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Usage month from'), { target: { value: '2026-08' } });
    fireEvent.change(screen.getByLabelText('Usage month to'), { target: { value: '2026-07' } });

    expect(await screen.findByText('The start month must not be after the end month.')).toBeInTheDocument();
    expect(usageRange).toHaveBeenCalledOnce();
  });
});
