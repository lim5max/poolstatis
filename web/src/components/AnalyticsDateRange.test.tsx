import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AnalyticsDateRange } from './AnalyticsDateRange';

describe('AnalyticsDateRange', () => {
  it('keeps quick periods visible and reports preset changes immediately', () => {
    const onChange = vi.fn();
    render(
      <AnalyticsDateRange
        value={{ kind: 'preset', preset: '30d' }}
        onChange={onChange}
      />,
    );

    expect(screen.getByRole('group', { name: 'Analytics period' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Today' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Yesterday' })).toBeVisible();
    expect(screen.getByRole('button', { name: '7 days' })).toBeVisible();
    expect(screen.getByRole('button', { name: '30 days' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '90 days' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Custom' })).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Today' }));
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

    fireEvent.click(screen.getByRole('button', { name: 'Custom' }));
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
    fireEvent.click(screen.getByRole('button', { name: 'Custom' }));
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
