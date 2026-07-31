import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ErrorNote, WarningNote } from './ui';

describe('status notes', () => {
  it('keeps error copy readable on the dark translucent surface', () => {
    const { container } = render(<ErrorNote>Route analysis requires setup.</ErrorNote>);
    const alert = screen.getByRole('alert');

    expect(alert).toHaveClass('text-destructive');
    expect(alert).not.toHaveClass('text-destructive-foreground');
    expect(alert).not.toHaveTextContent('⚠');
    expect(container.querySelector('svg')).not.toBeNull();
  });

  it('uses the warning token and the same Hugeicons treatment', () => {
    const { container } = render(<WarningNote>Review the measurement state.</WarningNote>);
    const note = screen.getByRole('status');

    expect(note).toHaveClass('text-warning');
    expect(note).not.toHaveTextContent('⚠');
    expect(container.querySelector('svg')).not.toBeNull();
  });
});
