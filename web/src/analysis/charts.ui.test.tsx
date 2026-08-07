import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { TrendQueryResult, VisualizationSpec } from './visualization';
import { ManualVisualizationRenderer } from './charts';

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AreaChart: () => <div data-testid="area-chart" />,
  BarChart: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  LineChart: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Area: () => null,
  Bar: () => null,
  CartesianGrid: () => null,
  Legend: () => null,
  Line: () => null,
  Tooltip: () => null,
  XAxis: () => null,
  YAxis: () => null,
}));

const query = {
  kind: 'trend' as const,
  metric: 'web_page_views',
  date_from: '2026-07-28T00:00:00.000Z',
  date_to: '2026-08-07T00:00:00.000Z',
  interval: 'day' as const,
  filters: [],
  env: 'prod',
};

const spec: VisualizationSpec = {
  schemaVersion: 1,
  id: 'web-page-views',
  kind: 'trend',
  title: 'Page views',
  question: 'How did traffic change?',
  purpose: 'Measure accepted canonical page views.',
  project: 'alpha',
  env: 'prod',
  range: { from: query.date_from, to: query.date_to, timezone: 'UTC' },
  source: { kind: 'metric', key: query.metric, query },
  trust: { status: 'trusted', reason: 'Canonical definition active.', blockers: [] },
  evidence: {
    aggregation: 'count by day', denominator: null, sampleSize: 12, coverage: '100% timed pages',
    source: 'native', computedAt: '2026-08-07T00:01:00.000Z', comparisonBasis: 'none',
  },
  display: { granularity: 'day', compare: 'none', series: [{ key: 'total', label: 'Views', colorToken: '--chart-1' }] },
  actions: [{ kind: 'open_metric', key: query.metric }],
};

const result: TrendQueryResult = {
  kind: 'trend',
  series: [{ bucket: '2026-08-07T00:00:00.000Z', value: 12 }],
  meta: {
    computed_at: '2026-08-07T00:01:00.000Z',
    date_range: { from: query.date_from, to: query.date_to },
    sampling: null,
    source: 'native',
  },
};

describe('manual visualization actions', () => {
  it('keeps the primary action compact and gives the technical fallback its own full-width row', () => {
    render(<MemoryRouter><ManualVisualizationRenderer spec={spec} result={result} /></MemoryRouter>);

    const actions = screen.getByRole('group', { name: 'Visualization actions' });
    expect(within(actions).getByRole('link', { name: 'Open definition' })).toBeInTheDocument();
    expect(within(actions).queryByText('Table fallback & reproducible query')).not.toBeInTheDocument();

    const summary = screen.getByText('Table fallback & reproducible query');
    const disclosure = summary.closest('details');
    expect(disclosure).not.toBeNull();
    expect(actions.contains(disclosure)).toBe(false);
    expect(disclosure).not.toHaveAttribute('open');

    fireEvent.click(summary);
    expect(disclosure).toHaveAttribute('open');
    expect(screen.getByRole('columnheader', { name: 'Bucket (UTC)' })).toBeInTheDocument();
  });
});
