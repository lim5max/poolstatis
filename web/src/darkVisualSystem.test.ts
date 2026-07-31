import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Core dark visual system', () => {
  it('keeps the admin dark while preserving the established font roles', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');
    const main = readFileSync(resolve(process.cwd(), 'src/main.tsx'), 'utf8');

    expect(css).toContain('color-scheme: dark');
    expect(css).toContain('--background: #0b0c0a');
    expect(css).toContain('--brand-lime: #cdfa4f');
    expect(css).toContain('--font-sans: "Geist"');
    expect(css).toContain('--font-mono: "Geist Mono"');
    expect(css).toContain('--font-serif: "STIX Two Text"');
    expect(main).toContain("document.documentElement.classList.add('dark')");
  });
});
