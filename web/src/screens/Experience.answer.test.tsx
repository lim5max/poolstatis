import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useStore } from '../store';
import { Experience } from './Experience';

vi.mock('../store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../store')>()),
  useStore: vi.fn(),
}));

const mockedStore = vi.mocked(useStore);

function store(client: Record<string, unknown>) {
  return {
    client,
    project: 'alpha',
    env: 'prod',
    availableEnvs: ['prod'],
    setEnv: vi.fn(),
  } as never;
}

const surface = {
  id: 'surface-1',
  key: 'checkout',
  name: 'Checkout',
  purpose: 'Find aggregate checkout friction before changing the flow.',
  status: 'active' as const,
  created_at: '2026-08-01T00:00:00.000Z',
  updated_at: '2026-08-10T00:00:00.000Z',
  last_capture_at: '2026-08-10T12:00:00.000Z',
};

const route = {
  id: 'route-1',
  surface_key: surface.key,
  key: 'payment',
  name: 'Payment',
  path_pattern: '/checkout/payment',
  created_at: '2026-08-01T00:00:00.000Z',
  updated_at: '2026-08-10T00:00:00.000Z',
};

const snapshot = {
  id: 'snapshot-1',
  surface_key: surface.key,
  route_key: route.key,
  env: 'prod',
  version: 'release-42',
  device: 'desktop' as const,
  release_hash: 'abc1234567890',
  mime_type: 'image/png' as const,
  byte_size: 2048,
  width: 1440,
  height: 2400,
  viewport_width: 1440,
  viewport_height: 900,
  document_width: 1440,
  document_height: 2400,
  captured_at: '2026-08-10T11:00:00.000Z',
  expires_at: '2026-11-10T11:00:00.000Z',
  created_at: '2026-08-10T11:00:00.000Z',
  evidence_ref: 'experience_snapshot:snapshot-1',
  stale: false,
};

const visualExperience = {
  kind: 'visual_experience' as const,
  surface: {
    key: surface.key,
    name: surface.name,
    purpose: surface.purpose,
    status: surface.status,
  },
  route: route.key,
  version: snapshot.version,
  device: snapshot.device,
  grid: 24,
  snapshot,
  summary: {
    events: 137,
    page_views: 63,
    sessions: 61,
    actors: 44,
    clicks: 19,
    max_document_width: 1440,
    max_document_height: 2400,
  },
  click_cells: [{ x: 2, y: 3, count: 9, actors: 7 }],
  click_labels: [{ label: 'payment.confirm', count: 9, actors: 7 }],
  click_labels_truncated: false,
  scroll_coverage: [{ depth: 50, sessions: 33, actors: 28, percentage: 54 }],
  sections: [
    { section: 'pricing', top: 0.25, sessions: 52, actors: 40, percentage: 85, dropoff_percentage: 0 },
    { section: 'payment', top: 0.55, sessions: 31, actors: 27, percentage: 51, dropoff_percentage: 40 },
  ],
  sections_truncated: false,
  agent_context: {
    scope: {
      surface: surface.key,
      route: route.key,
      version: snapshot.version,
      device: snapshot.device,
      purpose: surface.purpose,
    },
    sample_size: { events: 137, page_views: 63, sessions: 61, actors: 44, clicks: 19 },
    section_order: ['pricing', 'payment'],
    largest_section_reach_decreases: [{
      from_section: 'pricing',
      to_section: 'payment',
      from_sessions: 52,
      to_sessions: 31,
      session_count_decrease: 21,
      percentage_point_decrease: 34,
    }],
    click_concentration: [{
      label: 'payment.confirm',
      count: 9,
      actors: 7,
      percentage_of_all_clicks: 47,
    }],
    scroll_reach: [{ depth: 50, sessions: 33, actors: 28, percentage: 54 }],
    output_coverage: {
      click_labels_returned: 1,
      click_labels_truncated: false,
      sections_returned: 2,
      sections_truncated: false,
    },
    snapshot_coverage: {
      status: 'fresh' as const,
      exact_viewport_match: true,
      snapshot_id: snapshot.id,
      evidence_ref: snapshot.evidence_ref,
      captured_at: snapshot.captured_at,
      expires_at: snapshot.expires_at,
      age_seconds: 3600,
    },
    evidence_refs: [{ type: 'experience_snapshot' as const, id: snapshot.id, evidence_ref: snapshot.evidence_ref }],
    data_quality: { status: 'ok' as const, caveats: ['Host pause controls may exclude consent-withheld signals.'] },
    suggested_next_actions: [],
  },
  causality: 'Aggregate reach does not prove why sessions stopped or that a release caused the decrease.',
  meta: {
    computed_at: '2026-08-11T09:00:00.000Z',
    date_range: { from: '2026-07-12T09:00:00.000Z', to: '2026-08-11T09:00:00.000Z' },
  },
};

describe('Experience answer-first control surface', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  });

  it('labels the setup preview illustrative and links it to the canonical Experience evidence model', async () => {
    mockedStore.mockReturnValue(store({
      experienceSurfaces: vi.fn().mockResolvedValue([]),
      experienceRoutes: vi.fn().mockResolvedValue([]),
      experienceSnapshots: vi.fn().mockResolvedValue([]),
    }));

    render(<TooltipProvider><Experience /></TooltipProvider>);

    expect(await screen.findByText('Set up Browser Experience')).toBeInTheDocument();
    expect(screen.getByText(/Illustrative/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Visual Experience Maps v1 evidence model' })).toHaveAttribute(
      'href',
      'https://github.com/lim5max/poolstatis/blob/main/docs/10-visual-experience-maps.md#evidence-model',
    );
  });

  it('avoids smooth setup scrolling when reduced motion is requested', async () => {
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
    mockedStore.mockReturnValue(store({
      experienceSurfaces: vi.fn().mockResolvedValue([]),
      experienceRoutes: vi.fn().mockResolvedValue([]),
      experienceSnapshots: vi.fn().mockResolvedValue([]),
    }));

    render(<TooltipProvider><Experience /></TooltipProvider>);

    fireEvent.click(await screen.findByRole('button', { name: 'Set up manually' }));
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'auto', block: 'start' });
  });

  it('leads the ready screen with a server-derived friction answer, delta, readiness, and trust before the map', async () => {
    mockedStore.mockReturnValue(store({
      experienceSurfaces: vi.fn().mockResolvedValue([surface]),
      experienceRoutes: vi.fn().mockResolvedValue([route]),
      experienceSnapshots: vi.fn().mockResolvedValue([snapshot]),
      visualExperience: vi.fn().mockResolvedValue(visualExperience),
      experienceSnapshotImage: vi.fn().mockResolvedValue('blob:checkout-snapshot'),
      experienceSession: vi.fn().mockResolvedValue({ events: [], summary: { events: 0, sessions: 0, actors: 0 } }),
      compareVisualExperience: vi.fn(),
      interactionMap: vi.fn(),
    }));

    render(<TooltipProvider><Experience /></TooltipProvider>);

    const answer = await screen.findByRole('region', { name: 'Aggregate friction answer' });
    expect(await within(answer).findByText(/^The largest observed adjacent reach decrease is pricing → payment/)).toHaveTextContent('21 fewer sessions (34 pp)');
    expect(within(answer).getByText('Trusted evidence')).toBeInTheDocument();
    expect(within(answer).getByText(/Observed · Trusted · 137 events ·/)).toBeInTheDocument();
    expect(within(answer).getByText('Evidence ready')).toBeInTheDocument();
    expect(within(answer).getByText('61')).toBeInTheDocument();
    expect(within(answer).getByText('44')).toBeInTheDocument();

    const mapHeading = screen.getByText('Page evidence');
    expect(answer.compareDocumentPosition(mapHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('img', { name: /Checkout, payment, release-42, desktop/ })).toBeInTheDocument());
  });
});
