import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  CategorySelector,
  MetricCategoriesPanel,
  MetricCategoryFilter,
} from './components/metric-categories';
import type { MetricCategoryDefinition } from './api/types';

const categories: MetricCategoryDefinition[] = [
  {
    id: 'activation-id',
    key: 'activation',
    name: 'Activation',
    description: 'Measures the first moment a user receives meaningful product value.',
    domain: 'product',
    color: '#7C3AED',
    is_system: true,
    metric_count: 3,
  },
  {
    id: 'revenue-id',
    key: 'revenue',
    name: 'Revenue',
    description: 'Measures money earned from customers and product usage.',
    domain: 'business',
    color: '#16A34A',
    is_system: true,
    metric_count: 2,
  },
  {
    id: 'reliability-id',
    key: 'reliability',
    name: 'Reliability',
    description: 'Measures availability, errors, and continuity of service.',
    domain: 'technical',
    color: '#DC2626',
    is_system: true,
    metric_count: 1,
  },
  {
    id: 'governance-id',
    key: 'governance',
    name: 'Governance',
    description: 'Measures policy outcomes outside the stable system library.',
    domain: 'custom',
    color: '#6D5BD0',
    is_system: false,
    metric_count: 0,
  },
];

describe('metric taxonomy admin', () => {
  it('drives grouped selectors and filters from project definitions', () => {
    const onChange = vi.fn();
    const onToggle = vi.fn();
    function SelectorHarness() {
      const [value, setValue] = useState<string | null>(null);
      return (
        <CategorySelector
          categories={categories}
          value={value}
          onChange={(next) => {
            onChange(next);
            setValue(next);
          }}
        />
      );
    }
    render(
      <>
        <SelectorHarness />
        <MetricCategoryFilter categories={categories} selected={new Set()} onToggle={onToggle} />
      </>,
    );

    const selector = screen.getByRole('combobox', { name: 'Metric category' });
    expect(within(selector).getByRole('group', { name: 'Product' })).toBeInTheDocument();
    expect(within(selector).getByRole('group', { name: 'Business' })).toBeInTheDocument();
    expect(within(selector).getByRole('group', { name: 'Technical' })).toBeInTheDocument();
    expect(within(selector).getByRole('group', { name: 'Custom' })).toBeInTheDocument();
    expect(within(selector).getByRole('option', { name: 'Reliability' })).toHaveValue('reliability');
    expect(within(selector).queryByRole('option', { name: /^Technical$/ })).not.toBeInTheDocument();
    fireEvent.change(selector, { target: { value: 'governance' } });
    expect(onChange).toHaveBeenCalledWith('governance');
    expect(screen.getByText('Measures policy outcomes outside the stable system library.')).toBeInTheDocument();

    const filterTrigger = screen.getByRole('button', { name: 'Category' });
    filterTrigger.focus();
    fireEvent.keyDown(filterTrigger, { key: 'Enter', code: 'Enter' });
    expect(screen.getAllByText('Uncategorized').length).toBeGreaterThan(1);
    expect(screen.getAllByText('Reliability').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /Reliability/ }));
    expect(onToggle).toHaveBeenCalledWith('reliability');
  });

  it('groups purpose definitions and keeps system categories visibly locked', () => {
    render(
      <MetricCategoriesPanel
        categories={categories}
        onCreate={vi.fn()}
        onUpdate={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Product' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Business' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Technical' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Custom' })).toBeInTheDocument();
    expect(screen.getByText('Measures availability, errors, and continuity of service.')).toBeInTheDocument();

    const reliability = screen.getByTestId('metric-category-reliability');
    expect(within(reliability).getByText('Locked')).toBeInTheDocument();
    expect(within(reliability).queryByRole('button', { name: /edit/i })).not.toBeInTheDocument();
    expect(within(reliability).queryByRole('button', { name: /delete/i })).not.toBeInTheDocument();

    const custom = screen.getByTestId('metric-category-governance');
    expect(within(custom).getByRole('button', { name: 'Edit Governance' })).toBeInTheDocument();
    expect(within(custom).getByRole('button', { name: 'Delete Governance' })).toBeInTheDocument();
    expect(within(custom).getByText('0 metrics')).toBeInTheDocument();
  });

  it('creates a custom category with keyboard focus and preserves an API error', async () => {
    const onCreate = vi.fn()
      .mockRejectedValueOnce(new Error('metric category governance already exists'))
      .mockResolvedValueOnce(undefined);
    render(
      <MetricCategoriesPanel
        categories={categories}
        onCreate={onCreate}
        onUpdate={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Create custom category' }));
    const dialog = screen.getByRole('dialog', { name: 'Create custom category' });
    expect(within(dialog).getByLabelText('Key')).toHaveFocus();
    fireEvent.change(within(dialog).getByLabelText('Key'), { target: { value: 'governance' } });
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Governance' } });
    fireEvent.change(within(dialog).getByLabelText('Description'), {
      target: { value: 'Measures policy outcomes outside the stable system library.' },
    });
    fireEvent.change(within(dialog).getByLabelText('Color'), { target: { value: '#6d5bd0' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create category' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'metric category governance already exists',
    );
    expect(screen.getByRole('dialog', { name: 'Create custom category' })).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Create category' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Create custom category' })).not.toBeInTheDocument());
    expect(onCreate).toHaveBeenLastCalledWith({
      key: 'governance',
      name: 'Governance',
      description: 'Measures policy outcomes outside the stable system library.',
      domain: 'custom',
      color: '#6D5BD0',
    });
  });

  it('renders loading, error, and empty states without a desktop-only layout', () => {
    const { rerender } = render(
      <MetricCategoriesPanel
        categories={null}
        loading
        onCreate={vi.fn()}
        onUpdate={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    expect(screen.getByText('reading metric categories…')).toBeInTheDocument();

    rerender(
      <MetricCategoriesPanel
        categories={null}
        error="cannot load categories"
        onRetry={vi.fn()}
        onCreate={vi.fn()}
        onUpdate={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('cannot load categories');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();

    rerender(
      <MetricCategoriesPanel
        categories={[]}
        onCreate={vi.fn()}
        onUpdate={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    expect(screen.getByText('No category definitions')).toBeInTheDocument();

    rerender(
      <MetricCategoriesPanel
        categories={categories}
        onCreate={vi.fn()}
        onUpdate={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    expect(screen.getByTestId('metric-category-groups')).toHaveClass('grid');
  });
});
