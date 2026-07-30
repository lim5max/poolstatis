import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SOURCE_ROOT = dirname(fileURLToPath(import.meta.url));
const ALLOWED_PX = new Set([12, 14, 16, 18, 20, 24, 30, 36, 48, 60, 72]);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    if (!/\.(css|ts|tsx)$/.test(entry.name) || /\.test\.(ts|tsx)$/.test(entry.name)) return [];
    return [path];
  });
}

describe('Core typography scale', () => {
  it('rejects arbitrary pixel text, non-system literal font sizes, and negative tracking', () => {
    const violations: string[] = [];
    for (const path of sourceFiles(SOURCE_ROOT)) {
      const source = readFileSync(path, 'utf8');
      if (/text-\[\d+px\]/.test(source)) violations.push(`${path}: arbitrary Tailwind text size`);
      if (/tracking-(?:tighter|tight)/.test(source) || /letter-spacing:\s*-/.test(source)) {
        violations.push(`${path}: negative tracking`);
      }
      for (const match of source.matchAll(/(?:fontSize\s*:\s*|font-size\s*:\s*)(\d+)(?:px)?/g)) {
        if (!ALLOWED_PX.has(Number(match[1]))) violations.push(`${path}: non-system font size ${match[1]}px`);
      }
    }
    expect(violations).toEqual([]);
  });
});
