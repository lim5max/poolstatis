import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Registry } from './screens/Registry';
import { useStore } from './store';
import { TooltipProvider } from './components/ui/tooltip';

vi.mock('./store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./store')>()),
  useStore: vi.fn(),
}));

const mockedStore = vi.mocked(useStore);
const definitions = [
  {
    id: 'activation-id', key: 'activation', name: 'Activation',
    description: 'Measures the first moment a user receives meaningful product value.',
    domain: 'product', color: '#7C3AED', is_system: true, metric_count: 1,
  },
  {
    id: 'reliability-id', key: 'reliability', name: 'Reliability',
    description: 'Measures availability, errors, and continuity of service.',
    domain: 'technical', color: '#DC2626', is_system: true, metric_count: 0,
  },
  {
    id: 'governance-id', key: 'governance', name: 'Governance',
    description: 'Measures project-specific policy outcomes.',
    domain: 'custom', color: '#6D5BD0', is_system: false, metric_count: 0,
  },
] as const;

const schema = {
  project: { slug: 'alpha', name: 'Alpha' },
  env: 'prod',
  metrics: [{
    id: 'm1', key: 'activated_users', name: 'Activated users',
    purpose: 'Measure people who receive meaningful product value.',
    category: 'activation', tags: ['surface:onboarding'], type: 'unique_actors',
    source: { event: 'onboarding.completed' }, status: 'active',
    owner: null, deprecation_reason: null, deprecated_at: null,
  }],
  metric_categories: definitions,
  funnels: [],
  entity_types: [],
  observed_events_30d: [],
  properties: [],
  identity: {},
  sources: [],
};

describe('Registry metric taxonomy', () => {
  const updateMetricTaxonomy = vi.fn().mockResolvedValue({});
  const createMetricCategory = vi.fn().mockResolvedValue({});
  const updateMetricCategory = vi.fn().mockResolvedValue({});
  const deleteMetricCategory = vi.fn().mockResolvedValue({});
  const schemaCall = vi.fn().mockResolvedValue(schema);

  beforeEach(() => {
    vi.clearAllMocks();
    schemaCall.mockResolvedValue(schema);
    mockedStore.mockReturnValue({
      client: {
        schema: schemaCall,
        updateMetricTaxonomy,
        createMetricCategory,
        updateMetricCategory,
        deleteMetricCategory,
      },
      project: 'alpha',
      env: 'prod',
      availableEnvs: ['prod'],
      setEnv: vi.fn(),
    } as never);
  });

  it('manages definitions and edits category plus namespaced tags from the registry', async () => {
    render(
      <TooltipProvider>
        <MemoryRouter><Registry /></MemoryRouter>
      </TooltipProvider>,
    );

    expect(await screen.findByRole('tab', { name: 'Categories · 3' })).toBeInTheDocument();
    expect(screen.getByText('Activation')).toBeInTheDocument();

    const actions = screen.getByRole('button', { name: 'More actions' });
    actions.focus();
    fireEvent.keyDown(actions, { key: 'Enter', code: 'Enter' });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit category & tags' }));
    const dialog = screen.getByRole('dialog', { name: 'Taxonomy · Activated users' });
    const selector = within(dialog).getByRole('combobox', { name: 'Metric category' });
    expect(within(selector).getByRole('group', { name: 'Technical' })).toBeInTheDocument();
    fireEvent.change(selector, { target: { value: 'reliability' } });
    fireEvent.change(within(dialog).getByLabelText('Namespaced tags'), {
      target: { value: 'surface:checkout, component:payment-form' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save taxonomy' }));

    await waitFor(() => expect(updateMetricTaxonomy).toHaveBeenCalledWith(
      'alpha',
      'activated_users',
      { category: 'reliability', tags: ['surface:checkout', 'component:payment-form'] },
    ));
  });

  it('wires custom category creation to the project API and reloads definitions', async () => {
    render(
      <TooltipProvider>
        <MemoryRouter><Registry /></MemoryRouter>
      </TooltipProvider>,
    );
    const categoriesTab = await screen.findByRole('tab', { name: 'Categories · 3' });
    await act(async () => {
      categoriesTab.focus();
      fireEvent.keyDown(categoriesTab, { key: 'Enter', code: 'Enter' });
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Create custom category' }));
    const dialog = screen.getByRole('dialog', { name: 'Create custom category' });
    fireEvent.change(within(dialog).getByLabelText('Key'), { target: { value: 'governance' } });
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Governance' } });
    fireEvent.change(within(dialog).getByLabelText('Description'), {
      target: { value: 'Measures project-specific policy outcomes.' },
    });
    fireEvent.change(within(dialog).getByLabelText('Color'), { target: { value: '#6d5bd0' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create category' }));

    await waitFor(() => expect(createMetricCategory).toHaveBeenCalledWith('alpha', {
      key: 'governance',
      name: 'Governance',
      description: 'Measures project-specific policy outcomes.',
      domain: 'custom',
      color: '#6D5BD0',
    }));
    expect(schemaCall).toHaveBeenCalledTimes(2);
  });
});
