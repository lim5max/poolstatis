import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useStore } from '../store';
import { WebAnalytics } from './WebAnalytics';

vi.mock('../store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../store')>()),
  useStore: vi.fn(),
}));

vi.mock('../analysis/charts', () => ({
  ManualVisualizationRenderer: () => <div data-testid="web-trend" />,
}));

const mockedStore = vi.mocked(useStore);

const metric = {
  id: 'web',
  key: 'web_page_views',
  name: 'Web page views',
  purpose: 'Count canonical browser page views over time.',
  category: 'acquisition',
  tags: ['browser-analytics'],
  type: 'count',
  source: { event: 'page.viewed' },
  status: 'active',
  owner: null,
  deprecation_reason: null,
  deprecated_at: null,
} as const;

describe('Web analytics partial availability', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const operationalQuery = vi.fn().mockImplementation((_project, query) => {
      if (query.kind === 'web_analytics') {
        return Promise.resolve({
          kind: 'web_analytics',
          summary: {
            visitors: 8,
            sessions: 11,
            page_views: 20,
            average_session_duration_ms: null,
          },
          engagement: {
            measured_sessions: 9,
            incomplete_sessions: 2,
            unknown_sessions: 2,
            engaged_sessions: 6,
            bounce_sessions: 3,
            measured_session_coverage: 9 / 11,
            engaged_rate: 6 / 9,
            bounce_rate: 3 / 9,
            single_page_sessions: 7,
            timed_page_views: 18,
            total_page_views: 20,
            timed_page_coverage: 0.9,
            foreground_ms: 125_000,
            session_span_ms: 240_000,
          },
          breakdowns: {
            source: [{
              value: 'telegram',
              visitors: 6,
              sessions: 8,
              page_views: 15,
              percentage: 75,
            }],
            device: [],
            browser: [],
          },
          meta: {
            computed_at: '2026-07-31T00:00:00.000Z',
            date_range: {
              from: '2026-07-01T00:00:00.000Z',
              to: '2026-07-31T00:00:00.000Z',
            },
            sampling: null,
            source: 'native',
            truncated_dimensions: [],
            unavailable_dimensions: {
              route: {
                code: 'safe_route_unavailable',
                reason: 'Route analysis requires a trusted route vocabulary.',
                next_action: 'Configure trusted route keys.',
              },
              campaign: {
                code: 'acquisition_property_untrusted',
                reason: 'Campaign attribution is not trusted yet.',
                next_action: 'Review the campaign property.',
              },
              medium: {
                code: 'acquisition_property_untrusted',
                reason: 'Medium attribution is not trusted yet.',
                next_action: 'Review the medium property.',
              },
              country: {
                code: 'web_analytics_dimension_unavailable',
                reason: 'Country enrichment is not active.',
                next_action: 'Keep country disabled until its server-side contract is reviewed.',
              },
            },
            definitions: {},
            accepted_event_accounting: 'Stored events remain unchanged.',
            privacy: 'Raw URLs are forbidden.',
          },
        });
      }
      if (query.kind === 'web_sessions') {
        return Promise.resolve({
          kind: 'web_sessions',
          sessions: [{
            session_id: 'session-1',
            actor_id: 'actor-1',
            started_at: '2026-07-31T00:00:00.000Z',
            ended_at: '2026-07-31T00:00:20.000Z',
            page_views: 2,
            timed_page_views: 2,
            foreground_ms: 15_000,
            session_span_ms: 20_000,
            engaged: true,
            bounce: false,
            single_page: false,
            complete: true,
          }],
          meta: {
            computed_at: '2026-07-31T00:00:21.000Z',
            date_range: {
              from: '2026-07-01T00:00:00.000Z',
              to: '2026-07-31T00:00:00.000Z',
            },
            sampling: null,
            source: 'native',
            total: 1,
            truncated: false,
            definitions: {},
          },
        });
      }
      throw new Error(`Unexpected query kind: ${query.kind}`);
    });
    mockedStore.mockReturnValue({
      project: 'y1blin-com',
      env: 'prod',
      client: {
        metrics: vi.fn().mockResolvedValue([metric]),
        operationalQuery,
        query: vi.fn().mockResolvedValue({
          kind: 'trend',
          series: [],
          meta: {
            computed_at: '2026-07-31T00:00:00.000Z',
            date_range: {
              from: '2026-07-01T00:00:00.000Z',
              to: '2026-07-31T00:00:00.000Z',
            },
            sampling: null,
            source: 'native',
          },
        }),
      },
    } as never);
  });

  it('keeps traffic, UTM source and sessions visible when routes are unavailable', async () => {
    render(
      <TooltipProvider>
        <MemoryRouter>
          <WebAnalytics />
        </MemoryRouter>
      </TooltipProvider>,
    );

    expect((await screen.findAllByText('Visitors')).length).toBeGreaterThan(0);
    expect(within(screen.getByText('resolved actors').parentElement!).getByText('8')).toBeInTheDocument();
    expect(within(screen.getByText('actor + session ID').parentElement!).getByText('11')).toBeInTheDocument();
    expect(within(screen.getByText('accepted canonical views').parentElement!).getByText('20')).toBeInTheDocument();
    expect(screen.getByText('telegram')).toBeInTheDocument();
    expect(screen.getByText('Route setup required')).toBeInTheDocument();

    expect(screen.getByText(/Observed · Partial · 20 events ·/)).toBeInTheDocument();

    fireEvent.keyDown(screen.getByRole('tab', { name: 'Pages' }), { key: 'Enter' });

    expect(screen.getByText('Pages unavailable')).toBeInTheDocument();
    expect(screen.getAllByText('Visitors').length).toBeGreaterThan(0);
    expect(screen.queryByText('telegram')).not.toBeInTheDocument();

    fireEvent.keyDown(screen.getByRole('tab', { name: 'Countries' }), { key: 'Enter' });
    expect(screen.getByText('Countries unavailable')).toBeInTheDocument();

    fireEvent.keyDown(screen.getByRole('tab', { name: 'Conversions' }), { key: 'Enter' });
    expect(screen.getByText('Choose a conversion to measure')).toBeInTheDocument();
    expect(screen.getByText(/will not display a zero/)).toBeInTheDocument();
  });
});
