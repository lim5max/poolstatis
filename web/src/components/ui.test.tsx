import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ErrorNote, WarningNote } from './ui';
import { Button } from './ui/button';

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

describe('button contrast', () => {
  it('keeps outline hover neutral instead of applying the brand accent', () => {
    render(<Button variant="outline">Open definition</Button>);
    const button = screen.getByRole('button', { name: 'Open definition' });

    expect(button).toHaveClass('hover:bg-muted', 'hover:text-foreground');
    expect(button).not.toHaveClass('hover:bg-accent', 'hover:text-accent-foreground');
  });
});
