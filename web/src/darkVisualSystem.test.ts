import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Core dark visual system', () => {
  it('uses neutral graphite surfaces while preserving lime interaction and the established font roles', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');
    const main = readFileSync(resolve(process.cwd(), 'src/main.tsx'), 'utf8');
    const card = readFileSync(resolve(process.cwd(), 'src/components/ui/card.tsx'), 'utf8');
    const dropdown = readFileSync(resolve(process.cwd(), 'src/components/ui/dropdown-menu.tsx'), 'utf8');
    const select = readFileSync(resolve(process.cwd(), 'src/components/ui/select.tsx'), 'utf8');

    expect(css).toContain('color-scheme: dark');
    expect(css).toContain('--background: #0b0c0e');
    expect(css).toContain('--card: #15171a');
    expect(css).toContain('--popover: #1a1c20');
    expect(css).toContain('--secondary: #23262b');
    expect(css).toContain('--muted: #1c1f23');
    expect(css).toContain('--sidebar: #101113');
    expect(css).toContain('--accent: #26321c');
    expect(css).toContain('--brand-lime: #cdfa4f');
    expect(css).not.toContain('--card: #151713');
    expect(css).not.toContain('--popover: #181b16');
    expect(css).toContain('--font-sans: "Geist"');
    expect(css).toContain('--font-mono: "Geist Mono"');
    expect(css).toContain('--font-serif: "STIX Two Text"');
    expect(card).toContain('bg-card');
    expect(dropdown).toContain('bg-popover');
    expect(select).toContain('bg-popover');
    expect(main).toContain("document.documentElement.classList.add('dark')");
  });
});
