import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { Registry } from './screens/Registry';
import { useStore } from './store';
import { TooltipProvider } from '@/components/ui/tooltip';

vi.mock('./store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./store')>()),
  useStore: vi.fn(),
}));

const mockedStore = vi.mocked(useStore);
const metric = {
  id: 'metric-1',
  key: 'signup',
  name: 'Signups',
  purpose: 'Counts completed signups for acquisition decisions.',
  category: 'acquisition',
  type: 'count',
  status: 'active',
  tags: [],
  source: { event: 'signup.completed', filters: [] },
};
const schema = {
  metrics: [metric],
  funnels: [{
    id: 'funnel-1',
    key: 'activation',
    name: 'Activation',
    goal: 'Move a new signup to the first meaningful product outcome.',
    steps: [{ metric_key: 'signup', label: 'Signed up' }],
    window_seconds: 86_400,
  }],
  entity_types: [{ name: 'account', description: 'Customer account' }],
  observed_events_30d: [],
};

function LocationProbe() {
  return <output data-testid="location">{useLocation().search}</output>;
}

describe('admin navigation accessibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mockedStore.mockReturnValue({
      client: {},
      projects: [],
      project: null,
      tokenKind: 'personal',
      projectScope: 'org',
      account: null,
      setProject: vi.fn(),
      refreshProjects: vi.fn(),
    } as never);
  });

  it('provides a bypass link, main landmark, route heading, and unique title', async () => {
    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>,
    );

    expect(screen.getByRole('link', { name: 'Skip to main content' })).toHaveAttribute('href', '#main-content');
    expect(screen.getByRole('main')).toHaveAttribute('id', 'main-content');
    expect(screen.getByRole('heading', { level: 1, name: 'Projects' })).toBeInTheDocument();
    await waitFor(() => expect(document.title).toBe('Projects — Poolstatis'));
  });
});

describe('registry navigation and keyboard controls', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedStore.mockReturnValue({
      client: { schema: vi.fn().mockResolvedValue(schema) },
      project: 'alpha',
      env: 'prod',
    } as never);
  });

  it('restores the subsection from the URL and updates it without losing browser context', async () => {
    render(
      <MemoryRouter initialEntries={['/registry?tab=funnels']}>
        <TooltipProvider>
          <Registry />
          <LocationProbe />
        </TooltipProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByRole('tab', { name: 'Funnels · 1' })).toHaveAttribute('data-state', 'active');
    const entityTab = screen.getByRole('tab', { name: 'Entity types · 1' });
    fireEvent.mouseDown(entityTab, { button: 0, ctrlKey: false });
    fireEvent.click(entityTab);
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('?tab=entities'));
    const metricsTab = screen.getByRole('tab', { name: 'Metrics · 1' });
    fireEvent.mouseDown(metricsTab, { button: 0, ctrlKey: false });
    fireEvent.click(metricsTab);
    await waitFor(() =>
      expect(screen.getByTestId('location').textContent).toBe(''),
    );
  });

  it('exposes sortable headers, filter state, search, and row actions to assistive tech', async () => {
    render(
      <MemoryRouter initialEntries={['/registry']}>
        <TooltipProvider>
          <Registry />
        </TooltipProvider>
      </MemoryRouter>,
    );

    const metricSort = await screen.findByRole('button', { name: 'Metric' });
    expect(metricSort.closest('th')).toHaveAttribute('aria-sort', 'ascending');
    fireEvent.click(metricSort);
    expect(metricSort.closest('th')).toHaveAttribute('aria-sort', 'descending');
    expect(screen.getByRole('textbox', { name: 'Search metrics' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'active' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Signups actions' })).toBeInTheDocument();
  });
});
