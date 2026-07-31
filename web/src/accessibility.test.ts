import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('fail-closed environment action', () => {
  it('keeps the retry target at least 44px tall on mobile', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf8');
    expect(source).toMatch(/className="h-11 md:h-9"[^>]*>Retry validation/);
  });
});
