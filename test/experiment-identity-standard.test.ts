import { describe, expect, it } from 'vitest';
import { INSTRUMENTATION_STANDARD } from '../src/mcp/standard.js';

describe('experiment identity standard', () => {
  it('allows a bounded browser visitor unit without presenting it as a user', () => {
    expect(INSTRUMENTATION_STANDARD).toContain('persistent first-party browser visitor id');
    expect(INSTRUMENTATION_STANDARD).toContain('browser_visitor');
    expect(INSTRUMENTATION_STANDARD).toContain('not as a user or');
    expect(INSTRUMENTATION_STANDARD).toContain('session id, page-view id');
    expect(INSTRUMENTATION_STANDARD).toContain('audited anonymous-to-authenticated actor');
  });
});
