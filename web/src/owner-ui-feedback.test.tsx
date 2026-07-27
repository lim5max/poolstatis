import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { Experiments } from './screens/Experiments';
import { Experience } from './screens/Experience';
import { useStore } from './store';

vi.mock('./store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./store')>()),
  useStore: vi.fn(),
}));
vi.mock('./oidc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./oidc')>()),
  hostedAuthEnabled: false,
  useHostedAuth: () => ({ logout: vi.fn() }),
}));

const mockedStore = vi.mocked(useStore);

const surface = {
  id: 'surface-1',
  key: 'landing',
  name: 'Poolstatis public pages',
  purpose: 'Understand where visitors interact with the public landing.',
  status: 'active',
  created_at: '2026-07-27T08:00:00.000Z',
  updated_at: '2026-07-27T08:00:00.000Z',
  last_capture_at: '2026-07-27T09:00:00.000Z',
} as const;

const route = {
  id: 'route-1',
  surface_key: 'landing',
  key: 'landing-home',
  name: 'Landing home',
  path_pattern: '/',
  created_at: '2026-07-27T08:00:00.000Z',
  updated_at: '2026-07-27T08:00:00.000Z',
} as const;

const mobileSnapshot = {
  id: 'snapshot-mobile',
  surface_key: 'landing',
  route_key: 'landing-home',
  env: 'prod',
  version: 'release-a',
  device: 'mobile',
  release_hash: 'abc123',
  mime_type: 'image/png',
  byte_size: 1200,
  width: 390,
  height: 1431,
  viewport_width: 390,
  viewport_height: 844,
  document_width: 390,
  document_height: 1431,
  captured_at: '2026-07-27T09:00:00.000Z',
  expires_at: '2026-10-27T09:00:00.000Z',
  created_at: '2026-07-27T09:00:00.000Z',
  evidence_ref: 'snapshot-mobile',
  stale: false,
} as const;

const desktopSnapshot = {
  ...mobileSnapshot,
  id: 'snapshot-desktop',
  device: 'desktop',
  width: 1440,
  height: 8676,
  viewport_width: 1440,
  viewport_height: 900,
  document_width: 1440,
  document_height: 8676,
  evidence_ref: 'snapshot-desktop',
} as const;

const visualResult = {
  kind: 'visual_experience',
  surface,
  route: 'landing-home',
  version: 'release-a',
  device: 'mobile',
  grid: 24,
  snapshot: mobileSnapshot,
  summary: {
    events: 8,
    page_views: 5,
    sessions: 5,
    actors: 1,
    clicks: 1,
    max_document_width: 390,
    max_document_height: 1431,
  },
  click_cells: [{ x: 2, y: 3, count: 1, actors: 1 }],
  click_labels: [{ label: 'hero.get_started', count: 1, actors: 1 }],
  scroll_coverage: [{ depth: 50, sessions: 2, actors: 1, percentage: 40 }],
  sections: [{ section: 'hero', top: 0, sessions: 5, actors: 1, percentage: 100, dropoff_percentage: 0 }],
  causality: 'Aggregated interaction evidence does not prove why users acted.',
  meta: { computed_at: '2026-07-27T09:01:00.000Z', date_range: { from: '2026-06-27', to: '2026-07-27' } },
} as const;

function experienceStore() {
  return {
    client: {
      experienceSurfaces: vi.fn().mockResolvedValue([surface]),
      experienceRoutes: vi.fn().mockResolvedValue([route]),
      experienceSnapshots: vi.fn().mockResolvedValue([mobileSnapshot, desktopSnapshot]),
      visualExperience: vi.fn().mockResolvedValue(visualResult),
      experienceSnapshotImage: vi.fn().mockResolvedValue('blob:mobile-snapshot'),
      interactionMap: vi.fn(),
    },
    project: 'poolstatis-xyz',
    env: 'prod',
    availableEnvs: ['prod'],
    setEnv: vi.fn(),
  };
}

describe('owner UI feedback regressions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  });

  it('shows a mobile capture at its viewport width inside a scrollable evidence frame', async () => {
    mockedStore.mockReturnValue(experienceStore() as never);
    render(<Experience />);

    await screen.findByRole('img', { name: /mobile/ });
    const viewport = screen.getByTestId('visual-snapshot-viewport');
    expect(viewport).toHaveClass('h-96', 'overflow-auto');
    expect(screen.getByTestId('visual-snapshot-canvas')).toHaveStyle({ width: 'min(100%, 390px)' });
    expect(screen.getByText('Mobile viewport · 390 × 844')).toBeInTheDocument();
  });

  it('keeps evidence notes below the screenshot and names the exact comparison target', async () => {
    mockedStore.mockReturnValue(experienceStore() as never);
    render(<Experience />);

    const viewport = await screen.findByTestId('visual-snapshot-viewport');
    const notes = screen.getByTestId('visual-evidence-notes');
    expect(viewport.compareDocumentPosition(notes) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Compare with desktop' })).toBeInTheDocument();
    expect(screen.getByText('Current: mobile · Comparison: desktop on the same version')).toBeInTheDocument();
  });

  it('renders long feature-flag content as a wrapping card instead of a colliding table row', async () => {
    mockedStore.mockReturnValue({
      ...experienceStore(),
      client: {
        flags: vi.fn().mockResolvedValue([{
          id: 'flag-1',
          key: 'landing_waitlist_cta_copy',
          name: 'Landing waitlist CTA copy',
          purpose: 'Test whether proof-oriented CTA copy increases qualified Cloud waitlist submissions without changing app routing.',
          status: 'active',
          salt: 'salt',
          variants: [
            { key: 'control', rollout_percentage: 50 },
            { key: 'proof_first', rollout_percentage: 50 },
          ],
          created_at: '2026-07-27T08:00:00.000Z',
          updated_at: '2026-07-27T08:00:00.000Z',
        }]),
        experiments: vi.fn().mockResolvedValue([]),
        metrics: vi.fn().mockResolvedValue([]),
      },
    } as never);
    render(<Experiments />);

    const card = await screen.findByRole('article', { name: 'Landing waitlist CTA copy' });
    expect(card).toHaveClass('grid');
    expect(within(card).getByText(/proof-oriented CTA copy/)).toHaveClass('break-words');
    expect(within(card).getByRole('button', { name: 'Archive' })).toBeInTheDocument();
  });

  it('removes the redundant Customer admin subtitle from desktop and mobile branding', async () => {
    mockedStore.mockReturnValue({
      client: {},
      projects: [],
      project: null,
      env: 'prod',
      setProject: vi.fn(),
      disconnect: vi.fn(),
      tokenKind: 'secret',
    } as never);
    render(<MemoryRouter><App /></MemoryRouter>);

    await waitFor(() => expect(screen.queryByText('Customer admin')).not.toBeInTheDocument());
  });
});
