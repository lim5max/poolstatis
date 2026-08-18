import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Core light-first visual system', () => {
  it('uses a quiet working canvas, controlled lime accent, and keeps dark tokens optional', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');
    const card = readFileSync(resolve(process.cwd(), 'src/components/ui/card.tsx'), 'utf8');
    const dropdown = readFileSync(resolve(process.cwd(), 'src/components/ui/dropdown-menu.tsx'), 'utf8');
    const select = readFileSync(resolve(process.cwd(), 'src/components/ui/select.tsx'), 'utf8');
    const button = readFileSync(resolve(process.cwd(), 'src/components/ui/button.tsx'), 'utf8');
    const input = readFileSync(resolve(process.cwd(), 'src/components/ui/input.tsx'), 'utf8');

    expect(css).toContain('color-scheme: light');
    expect(css).toContain('--background: #f6f8f5');
    expect(css).toContain('--card: #ffffff');
    expect(css).toContain('--foreground: #172019');
    expect(css).toContain('--muted-foreground: #687169');
    expect(css).toContain('--border: #dde3dc');
    expect(css).toContain('--brand-lime: #b9f542');
    expect(css).toContain('.dark {');
    expect(css).toContain('--background: #0b0c0e');
    expect(css).toContain('--font-sans: "Geist"');
    expect(css).toContain('--font-mono: "Geist Mono"');
    expect(css).toContain('--font-serif: "STIX Two Text"');
    expect(css).toContain('font-family: "Google Sans Flex"');
    expect(css).toContain('.auth-display');
    expect(css).toContain('--auth-display-tracking: -0.045em');
    expect(css).toContain('--auth-display-leading: 0.96');
    expect(css).toContain('letter-spacing: var(--auth-display-tracking)');
    expect(css).toContain('line-height: var(--auth-display-leading)');
    expect(existsSync(resolve(process.cwd(), 'public/fonts/google-sans-flex-latin.woff2'))).toBe(true);
    expect(css).toContain('--text-xs: 0.9375rem');
    expect(css).toContain('--text-sm: 1rem');
    expect(css).toContain('--radius-control: 9999px');
    expect(css).toContain('--radius-panel: 1.5rem');
    expect(button).toContain('rounded-full');
    expect(input).toContain('rounded-full');
    expect(select).toContain('rounded-full');
    expect(card).toContain('bg-card');
    expect(dropdown).toContain('bg-popover');
    expect(select).toContain('bg-popover');
  });
});
