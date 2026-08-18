import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AnalyticsDateRange } from './AnalyticsDateRange';

describe('AnalyticsDateRange', () => {
  it('keeps the current period compact and exposes presets from its menu', () => {
    const onChange = vi.fn();
    render(
      <AnalyticsDateRange
        value={{ kind: 'preset', preset: '30d' }}
        onChange={onChange}
      />,
    );

    expect(screen.getByRole('group', { name: 'Analytics period' })).toBeInTheDocument();
    const trigger = screen.getByRole('button', { name: 'Period: Last 30 days' });
    expect(trigger).toBeVisible();
    expect(screen.queryByText('Today')).not.toBeInTheDocument();

    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'Enter', code: 'Enter' });
    expect(screen.getByRole('menuitemcheckbox', { name: '30 days' })).toHaveAttribute('data-state', 'checked');
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Today' }));
    expect(onChange).toHaveBeenCalledWith({ kind: 'preset', preset: 'today' });
  });

  it('applies an inclusive custom calendar range and can be cancelled', () => {
    const onChange = vi.fn();
    const view = render(
      <AnalyticsDateRange
        value={{ kind: 'preset', preset: '30d' }}
        onChange={onChange}
      />,
    );

    const initialTrigger = screen.getByRole('button', { name: 'Period: Last 30 days' });
    initialTrigger.focus();
    fireEvent.keyDown(initialTrigger, { key: 'Enter', code: 'Enter' });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Custom period…' }));
    expect(screen.getByRole('dialog', { name: 'Custom period' })).toBeVisible();
    fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '2026-08-01' } });
    fireEvent.change(screen.getByLabelText('End date'), { target: { value: '2026-08-03' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply period' }));
    expect(onChange).toHaveBeenCalledWith({ kind: 'custom', from: '2026-08-01', to: '2026-08-03' });

    view.rerender(
      <AnalyticsDateRange
        value={{ kind: 'custom', from: '2026-08-01', to: '2026-08-03' }}
        onChange={onChange}
      />,
    );
    const customTrigger = screen.getByRole('button', { name: /Period: Aug 1.*3, 2026/ });
    customTrigger.focus();
    fireEvent.keyDown(customTrigger, { key: 'Enter', code: 'Enter' });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Change custom period…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog', { name: 'Custom period' })).not.toBeInTheDocument();
  });

  it('exposes comparison as an explicit pressed state', () => {
    const onCompareChange = vi.fn();
    render(
      <AnalyticsDateRange
        value={{ kind: 'preset', preset: '7d' }}
        onChange={vi.fn()}
        compare
        onCompareChange={onCompareChange}
      />,
    );

    const compare = screen.getByRole('button', { name: 'Compare to previous period' });
    expect(compare).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(compare);
    expect(onCompareChange).toHaveBeenCalledWith(false);
  });
});
