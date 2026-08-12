import { describe, expect, it } from 'vitest';
import { createMcpServer, validateMcpConfig } from '../src/mcp/server.js';

describe('MCP CLI configuration', () => {
  it('accepts a clean loopback HTTP origin and rejects unsafe tokens and URL components', () => {
    expect(validateMcpConfig({
      POOLSTATIS_URL: 'http://127.0.0.1:3300', POOLSTATIS_TOKEN: 'pt_0123456789abcdef',
    })).toEqual({ baseUrl: 'http://127.0.0.1:3300', token: 'pt_0123456789abcdef' });

    for (const env of [
      { POOLSTATIS_URL: 'https://user:secret@api.example.test', POOLSTATIS_TOKEN: 'pt_0123456789abcdef' },
      { POOLSTATIS_URL: 'https://api.example.test/?query=secret', POOLSTATIS_TOKEN: 'pt_0123456789abcdef' },
      { POOLSTATIS_URL: 'https://api.example.test/#fragment', POOLSTATIS_TOKEN: 'pt_0123456789abcdef' },
      { POOLSTATIS_URL: 'https://api.example.test', POOLSTATIS_TOKEN: 'pk_not_allowed' },
      { POOLSTATIS_URL: 'https://api.example.test', POOLSTATIS_TOKEN: ' ' },
    ]) {
      expect(() => validateMcpConfig(env)).toThrow(/POOLSTATIS_(URL|TOKEN)/);
    }
  });

  it('creates isolated side-effect-free server instances with immutable per-instance configuration', () => {
    const first = createMcpServer({ baseUrl: 'https://one.example.test', token: 'pt_1111111111111111' });
    const second = createMcpServer({ baseUrl: 'https://two.example.test', token: 'sk_2222222222222222' });
    expect(first).not.toBe(second);
  });

  it('keeps pending source tools out of the pinned 0.6.0 distribution', () => {
    const source = createMcpServer({
      baseUrl: 'https://source.example.test', token: 'pt_1111111111111111', distribution: 'source',
    });
    const published = createMcpServer({
      baseUrl: 'https://published.example.test', token: 'pt_2222222222222222', distribution: 'published-0.6.0',
    });
    expect((source as any)._registeredTools).toHaveProperty('create_funnel_investigation');
    expect((published as any)._registeredTools).not.toHaveProperty('create_funnel_investigation');
  });
});
