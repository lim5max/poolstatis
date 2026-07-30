import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('fail-closed environment action', () => {
  it('keeps the retry target at least 44px tall on mobile', () => {
    const source = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');
    expect(source).toMatch(/className="h-11 md:h-9"[^>]*>Retry validation/);
  });
});
