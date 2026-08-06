import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return extname(path) === '.tsx' && !path.endsWith('.test.tsx') ? [path] : [];
  });
}

describe('DisclosureSummary', () => {
  it('uses the Hugeicons right chevron and rotates it when the disclosure opens', () => {
    const componentPath = resolve(process.cwd(), 'src/components/disclosure.tsx');
    expect(existsSync(componentPath)).toBe(true);
    if (!existsSync(componentPath)) return;

    const source = readFileSync(componentPath, 'utf8');
    expect(source).toContain("import { ChevronRight } from '@/components/icons'");
    expect(source).toContain('data-slot="disclosure-chevron"');
    expect(source).toContain('list-none');
    expect(source).toContain('transition-transform');

    const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');
    expect(css).toContain('details[open] > summary [data-slot="disclosure-chevron"]');
  });

  it('keeps every product disclosure on the shared marker-free summary', () => {
    const root = resolve(process.cwd(), 'src');
    const rawSummaries = sourceFiles(root)
      .filter((path) => !path.endsWith('/components/disclosure.tsx'))
      .filter((path) => readFileSync(path, 'utf8').includes('<summary'));

    expect(rawSummaries).toEqual([]);
  });
});
