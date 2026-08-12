import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useStore } from '../store';
import { Measurement } from './Measurement';

vi.mock('../store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../store')>()),
  useStore: vi.fn(),
}));

const mockedStore = vi.mocked(useStore);

describe('Definitions surface', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedStore.mockReturnValue({
      project: 'alpha', env: 'prod',
      client: {
        measurementReadiness: vi.fn().mockResolvedValue({
          schema_version: 1,
          generated_at: '2026-08-11T10:00:00.000Z',
          project: 'alpha',
          env: 'prod',
          summary: { healthy_count: 2, incomplete_count: 1, highest_severity: 'high' },
          answer_dependencies: [
            {
              answer_id: 'home', surface: 'home', label: 'Home current answer', href: '/',
              metric_keys: ['signup'], property_keys: [], funnel_key: null,
            },
            {
              answer_id: 'answer-product-health', surface: 'saved', label: 'Product health',
              href: '/analyze/saved?answer=answer-product-health', metric_keys: ['signup'],
              property_keys: [], funnel_key: null,
            },
          ],
          groups: [
            {
              key: 'tracking_plan', label: 'Tracking plan', healthy_count: 0, incomplete_count: 1,
              highest_severity: 'high', evidence: { metrics: 1, funnels: 0 },
              repair_action: { action_code: 'activate_metric', kind: 'navigate', label: 'Review and activate metric', href: '/registry?metric=signup' },
              gaps: [{
                code: 'metric_inactive', severity: 'high', definition_ref: 'signup',
                affected_answer_ids: ['answer-product-health', 'home'],
                repair_action: { action_code: 'activate_metric', kind: 'navigate', label: 'Review and activate metric', href: '/registry?metric=signup' },
              }],
            },
            { key: 'properties', label: 'Properties', healthy_count: 1, incomplete_count: 0, highest_severity: 'none', evidence: {}, repair_action: null, gaps: [] },
            { key: 'identity', label: 'Identity', healthy_count: 1, incomplete_count: 0, highest_severity: 'none', evidence: {}, repair_action: null, gaps: [] },
            { key: 'data_sources', label: 'Data sources', healthy_count: 0, incomplete_count: 0, highest_severity: 'none', evidence: {}, repair_action: null, gaps: [] },
          ],
          fix_next: {
            group: 'tracking_plan', gap_code: 'metric_inactive', severity: 'high',
            affected_answer_ids: ['answer-product-health', 'home'], action_code: 'activate_metric', kind: 'navigate',
            label: 'Review and activate metric', href: '/registry?metric=signup',
          },
        }),
        properties: vi.fn().mockResolvedValue([]),
        actorLinks: vi.fn().mockResolvedValue({ links: [], audit: [] }),
        sources: vi.fn().mockResolvedValue([]),
        metrics: vi.fn().mockResolvedValue([]),
        contracts: vi.fn().mockResolvedValue([]),
      },
    } as never);
  });

  it('starts with four compact definition rows and progressive technical detail', async () => {
    render(<TooltipProvider><MemoryRouter><Measurement /></MemoryRouter></TooltipProvider>);

    expect(await screen.findByRole('heading', { name: 'Definitions', level: 1 })).toBeInTheDocument();
    for (const label of ['Tracking plan', 'Properties', 'Identity', 'Data sources']) {
      expect(screen.getByText(label, { selector: 'span' }).closest('details')).not.toHaveAttribute('open');
    }
    expect(screen.getByText('No external sources')).toBeInTheDocument();
    expect(screen.queryByText(/Canonical People/)).not.toBeInTheDocument();
    expect(screen.getAllByText(/healthy ·/).length).toBeGreaterThanOrEqual(4);
    expect(screen.getByText('Measurement health')).toBeInTheDocument();
    expect(screen.getByText('1 definition gap needs attention')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Home current answer' }).length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByRole('link', { name: 'Product health' }).length).toBeGreaterThanOrEqual(2);
    const repairLinks = screen.getAllByRole('link', { name: 'Review and activate metric' });
    expect(repairLinks).toHaveLength(2);
    repairLinks.forEach((link) => expect(link).toHaveAttribute('href', '/registry?metric=signup'));
    expect(screen.queryByText('Advanced web reporting')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Propose acquisition UTM properties' })).not.toBeInTheDocument();
  });

  it('opens the exact definition group requested by a server repair link', async () => {
    render(<TooltipProvider><MemoryRouter initialEntries={['/measurement?group=identity']}><Measurement /></MemoryRouter></TooltipProvider>);

    expect(await screen.findByText('Identity', { selector: 'span' }).then((node) => node.closest('details'))).toHaveAttribute('open');
    expect(screen.getByText(/No anonymous-to-identified links/)).toBeInTheDocument();
  });
});
