import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ErrorNote, Meter, PageHeading, WarningNote } from './ui';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Table, TableBody, TableRow } from './ui/table';
import { Tabs, TabsList, TabsTrigger } from './ui/tabs';

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

describe('page headings', () => {
  it('keeps methodology behind contextual help', () => {
    render(<PageHeading title="Web" lead="Traffic and outcomes." help="Only registered, purpose-backed outcomes are shown." />);
    expect(screen.getByRole('heading', { level: 1, name: 'Web' })).toBeInTheDocument();
    expect(screen.getByText('Traffic and outcomes.')).toBeInTheDocument();
    const methodology = screen.getByText('Only registered, purpose-backed outcomes are shown.');
    expect(methodology).not.toBeVisible();
    fireEvent.click(screen.getByText('?'));
    expect(methodology).toBeVisible();
  });
});

describe('button contrast', () => {
  it('keeps outline hover neutral instead of applying the brand accent', () => {
    render(<Button variant="outline">Open definition</Button>);
    const button = screen.getByRole('button', { name: 'Open definition' });

    expect(button).toHaveClass('hover:bg-muted', 'hover:text-foreground');
    expect(button).not.toHaveClass('hover:bg-accent', 'hover:text-accent-foreground');
  });

  it('keeps link actions persistently visible without green text', () => {
    render(
      <>
        <Button variant="link">Clear filters</Button>
        <Badge variant="link">Open metric</Badge>
      </>,
    );

    for (const action of [screen.getByRole('button', { name: 'Clear filters' }), screen.getByText('Open metric')]) {
      expect(action).toHaveClass('text-foreground', 'underline', 'decoration-muted-foreground/60');
      expect(action.className).not.toMatch(/text-(?:brand|success)(?:\s|$|\/)/);
    }
  });
});

describe('brand state colors', () => {
  it('uses the primary token for progress fills', () => {
    const { container } = render(<Meter value={0.75} />);
    expect(container.querySelector('.bg-primary')).not.toBeNull();
  });

  it('uses a primary tint for selected table rows', () => {
    render(<Table><TableBody><TableRow data-state="selected"><td>Selected</td></TableRow></TableBody></Table>);
    expect(screen.getByRole('row')).toHaveClass(
      'data-[state=selected]:bg-primary/10',
      'data-[state=selected]:border-l-brand-strong',
    );
  });

  it('uses the primary family for active tabs', () => {
    render(<Tabs defaultValue="one"><TabsList><TabsTrigger value="one">One</TabsTrigger></TabsList></Tabs>);
    expect(screen.getByRole('tab', { name: 'One' })).toHaveClass(
      'data-[state=active]:bg-primary/10',
      'data-[state=active]:border-brand-strong',
      'after:bg-primary',
    );
  });
});
