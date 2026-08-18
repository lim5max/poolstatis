import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useStore } from '../store';
import { Data } from './Data';

vi.mock('../store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../store')>()),
  useStore: vi.fn(),
}));

const mockedStore = vi.mocked(useStore);
const verify = vi.fn();
const sample = vi.fn();

const health = {
  schema_version: 1 as const,
  generated_at: '2026-08-11T12:00:00.000Z',
  project: 'alpha',
  env: 'prod',
  coverage: {
    accepted_basis: 'durable event rows by ingested_at',
    rejected_basis: 'privacy-safe warning occurrences recorded after data-health tracking began',
    rejected_history_first_observed_at: '2026-08-10T00:00:00.000Z',
    issue_novelty_basis: 'current 24 hourly buckets compared with the immediately preceding 24 hourly buckets',
  },
  summary: { accepted_24h: 240, rejected_24h: 2, accepted_7d: 950, rejected_7d: 3 },
  windows: {
    last_24h: {
      from: '2026-08-10T13:00:00.000Z', to: '2026-08-11T12:00:00.000Z', interval: 'hour' as const,
      accepted_total: 240, rejected_total: 2,
      points: [
        { bucket: '2026-08-11T11:00:00.000Z', accepted: 100, rejected: 0 },
        { bucket: '2026-08-11T12:00:00.000Z', accepted: 140, rejected: 2 },
      ],
    },
    last_7d: {
      from: '2026-08-05T00:00:00.000Z', to: '2026-08-11T12:00:00.000Z', interval: 'day' as const,
      accepted_total: 950, rejected_total: 3,
      points: [
        { bucket: '2026-08-10T00:00:00.000Z', accepted: 400, rejected: 1 },
        { bucket: '2026-08-11T00:00:00.000Z', accepted: 550, rejected: 2 },
      ],
    },
  },
  issue_signatures: [{
    signature_id: '11111111-1111-4111-8111-111111111111',
    kind: 'rejected' as const,
    category: 'schema_rejection' as const,
    remediation: 'fix_schema' as const,
    registered_event_name: 'checkout.failed',
    count: 2,
    first_seen: '2026-08-11T10:00:00.000Z',
    last_seen: '2026-08-11T12:00:00.000Z',
    novelty: {
      state: 'new' as const,
      basis: 'privacy-safe warning occurrences' as const,
      current_window: { from: '2026-08-10T13:00:00.000Z', to: '2026-08-11T12:00:00.000Z', count: 2 },
      comparison_baseline: { from: '2026-08-09T13:00:00.000Z', to: '2026-08-10T13:00:00.000Z', count: 0 },
    },
    affected_answer_ids: ['home', 'product:checkout_failed'],
    repair_action: { kind: 'navigate' as const, label: 'Inspect registered event', href: '/data?tab=events&event=checkout.failed' },
    watermark: { count: 2, last_seen: '2026-08-11T12:00:00.000Z' },
    verify_after_fix: {
      method: 'POST' as const,
      href: '/api/v1/projects/alpha/data-health/verify',
      body: {
        env: 'prod', signature_id: '11111111-1111-4111-8111-111111111111',
        watermark: { count: 2, last_seen: '2026-08-11T12:00:00.000Z' },
      },
    },
  }],
  improvements: [{
    signature_id: '11111111-1111-4111-8111-111111111111',
    severity: 'high' as const,
    title: 'Rejected observations need repair',
    affected_answer_ids: ['home', 'product:checkout_failed'],
    repair_action: { kind: 'navigate' as const, label: 'Inspect registered event', href: '/data?tab=events&event=checkout.failed' },
    verify_after_fix: {
      method: 'POST' as const,
      href: '/api/v1/projects/alpha/data-health/verify',
      body: {
        env: 'prod', signature_id: '11111111-1111-4111-8111-111111111111',
        watermark: { count: 2, last_seen: '2026-08-11T12:00:00.000Z' },
      },
    },
  }],
  doing_well: [{
    code: 'accepted_events_flowing' as const,
    title: 'Accepted events are flowing',
    evidence: '240 accepted observations in the latest 24 hourly buckets.',
  }],
};

describe('Events data-health control', () => {
  beforeEach(() => {
    sample.mockReset().mockResolvedValue([]);
    const watermark = health.issue_signatures[0]!.watermark;
    verify.mockReset().mockResolvedValue({
      schema_version: 1,
      signature_id: '11111111-1111-4111-8111-111111111111',
      status: 'resolved',
      occurrences_since_watermark: 0,
      checked_at: '2026-08-11T12:05:00.000Z',
      previous_watermark: watermark,
      current_watermark: watermark,
    });
    mockedStore.mockReturnValue({
      project: 'alpha', env: 'prod', availableEnvs: ['prod'], setEnv: vi.fn(),
      client: {
        schema: vi.fn().mockResolvedValue({
          project: { slug: 'alpha', name: 'Alpha' }, env: 'prod', metrics: [], metric_categories: [],
          funnels: [], entity_types: [], observed_events_30d: [], properties: [],
          identity: { active_links: 0, linked_sources: 0, audit_entries: 0 }, sources: [],
        }),
        dataHealth: vi.fn().mockResolvedValue(health),
        verifyDataHealthFix: verify,
        dataQuality: vi.fn().mockResolvedValue({ issues: [], checked: { terminal_event_specs: 0, evidence_rows: 0 } }),
        ingestWarnings: vi.fn().mockResolvedValue([]),
        sample,
      },
    } as never);
  });

  it('uses Today and custom exact periods for the event stream', async () => {
    sample.mockResolvedValue([{
      id: 'event-1',
      event: 'page.viewed',
      timestamp: '2026-08-01T10:00:00.000Z',
      distinct_id: 'actor-1',
      session_id: 'session-1',
      properties: {},
      registered: true,
      env: 'prod',
      revision: 1,
      origin: 'live',
      backfill_batch_id: null,
      ingested_at: '2026-08-01T10:00:01.000Z',
      editable: true,
    }]);
    render(<TooltipProvider><MemoryRouter initialEntries={['/data?tab=events']}><Data /></MemoryRouter></TooltipProvider>);
    await screen.findAllByText('Event stream');

    const period = screen.getByRole('group', { name: 'Analytics period' });
    fireEvent.click(within(period).getByRole('button', { name: 'Custom' }));
    fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '2026-08-01' } });
    fireEvent.change(screen.getByLabelText('End date'), { target: { value: '2026-08-02' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply period' }));

    await waitFor(() => expect(sample).toHaveBeenLastCalledWith('alpha', expect.objectContaining({
      from: '2026-08-01T00:00:00.000Z',
      to: '2026-08-03T00:00:00.000Z',
    })));
    expect(screen.getByRole('link', { name: 'actor-1' })).toHaveAttribute(
      'href',
      '/data/person/actor-1?range=custom&from=2026-08-01&to=2026-08-02',
    );
    expect(screen.queryByText('All time')).not.toBeInTheDocument();
  });

  it('preserves the selected period when an identity entity opens a person', async () => {
    mockedStore.mockReturnValue({
      project: 'alpha', env: 'prod', availableEnvs: ['prod'], setEnv: vi.fn(),
      client: {
        schema: vi.fn().mockResolvedValue({
          project: { slug: 'alpha', name: 'Alpha' }, env: 'prod', metrics: [], metric_categories: [],
          funnels: [], entity_types: [{ name: 'user' }], observed_events_30d: [], properties: [],
          identity: { active_links: 1, linked_sources: 1, audit_entries: 0 }, sources: [],
        }),
        entities: vi.fn().mockResolvedValue([{
          entity_id: 'actor-entity',
          properties: { email: 'person@example.com' },
          updated_at: '2026-08-01T10:00:00.000Z',
        }]),
      },
    } as never);

    render(<TooltipProvider><MemoryRouter initialEntries={['/data?tab=entities&range=today']}><Data /></MemoryRouter></TooltipProvider>);

    expect(await screen.findByRole('link', { name: 'actor-entity' })).toHaveAttribute(
      'href',
      '/data/person/actor-entity?range=today',
    );
  });

  it('shows server-owned trend totals before details and separates improvements from proven health', async () => {
    render(<TooltipProvider><MemoryRouter initialEntries={['/data']}><Data /></MemoryRouter></TooltipProvider>);

    const flow = await screen.findByRole('heading', { name: 'Data flow' });
    const panel = (flow.closest('[data-slot="card"]') ?? flow.parentElement!) as HTMLElement;
    expect(within(panel).getByText('240')).toBeInTheDocument();
    expect(within(panel).getAllByText('2').length).toBeGreaterThanOrEqual(1);
    expect(within(panel).getByRole('img', { name: /Accepted and rejected observations for 24 hours/ })).toBeInTheDocument();
    fireEvent.click(within(panel).getByText('View accepted and rejected data table'));
    const table = within(panel).getByRole('table', { name: 'Accepted and rejected observations for 24 hours' });
    expect(within(table).getByText('2026-08-11T11:00:00.000Z')).toBeInTheDocument();
    expect(within(table).getByRole('columnheader', { name: 'Rejected' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Improvements' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Doing well' })).toBeInTheDocument();
    expect(screen.getByText('Rejected observations need repair')).toBeInTheDocument();
    expect(screen.getByText('New in current 24h')).toBeInTheDocument();
    expect(screen.getByText('2 in current 24h · none in previous 24h')).toBeInTheDocument();
    expect(screen.getByText('Accepted events are flowing')).toBeInTheDocument();
    expect(screen.getByText(/home, product:checkout_failed/)).toBeInTheDocument();
    expect(screen.queryByText(/raw payload/i)).not.toBeInTheDocument();
  });

  it('does not claim full instrumentation coverage before the first accepted event', async () => {
    render(<TooltipProvider><MemoryRouter initialEntries={['/data']}><Data /></MemoryRouter></TooltipProvider>);

    const coverageLabel = await screen.findByText('Instrumentation coverage');
    const card = coverageLabel.closest<HTMLElement>('[data-slot="card"]')!;
    expect(within(card).getByText('Unavailable')).toBeInTheDocument();
    expect(within(card).getByRole('link', { name: 'Send the first event' })).toHaveAttribute('href', '/setup');
    expect(within(card).queryByText('100%')).not.toBeInTheDocument();
  });

  it('runs verify-after-fix with the exact server signature watermark and reports the read-back', async () => {
    render(<TooltipProvider><MemoryRouter initialEntries={['/data?signature=11111111-1111-4111-8111-111111111111']}><Data /></MemoryRouter></TooltipProvider>);

    fireEvent.click(await screen.findByRole('button', { name: 'Verify fix' }));
    await waitFor(() => expect(verify).toHaveBeenCalledWith('alpha', {
      env: 'prod',
      signature_id: '11111111-1111-4111-8111-111111111111',
      watermark: { count: 2, last_seen: '2026-08-11T12:00:00.000Z' },
    }));
    expect(await screen.findByText('No recurrence after this watermark')).toBeInTheDocument();
  });
});
