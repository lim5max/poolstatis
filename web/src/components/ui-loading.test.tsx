import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Loading } from './ui';

describe('Loading', () => {
  it('announces progress and uses a stable content skeleton instead of a spinner', () => {
    const { container } = render(<Loading what="Loading product answer…" />);

    expect(screen.getByRole('status', { name: 'Loading product answer…' })).toHaveAttribute('aria-busy', 'true');
    expect(container.querySelectorAll('[data-slot="loading-skeleton"]')).toHaveLength(4);
    expect(container.querySelector('svg')).toBeNull();
  });
});
