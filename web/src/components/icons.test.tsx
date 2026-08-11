import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ChevronDown, Database } from './icons';

describe('Poolstatis icon treatment', () => {
  it('renders semantic icons from Hugeicons Solid Rounded', () => {
    const markup = renderToStaticMarkup(<Database />);

    expect(markup).toContain('fill="currentColor"');
  });

  it('keeps dropdown chevrons in the stroke style', () => {
    const markup = renderToStaticMarkup(<ChevronDown />);

    expect(markup).toContain('stroke="currentColor"');
    expect(markup).not.toContain('fill="currentColor"');
  });
});
