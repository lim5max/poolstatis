import { describe, expect, it } from 'vitest';
import { validateMcpConfig } from '../src/mcp/server.js';

describe('MCP CLI configuration', () => {
  it('accepts a clean loopback HTTP origin and rejects unsafe tokens and URL components', () => {
    expect(validateMcpConfig({
      POOLSTATIS_URL: 'http://127.0.0.1:3300', POOLSTATIS_TOKEN: 'pt_test',
    })).toEqual({ baseUrl: 'http://127.0.0.1:3300', token: 'pt_test' });

    for (const env of [
      { POOLSTATIS_URL: 'https://user:secret@api.example.test', POOLSTATIS_TOKEN: 'pt_test' },
      { POOLSTATIS_URL: 'https://api.example.test/?query=secret', POOLSTATIS_TOKEN: 'pt_test' },
      { POOLSTATIS_URL: 'https://api.example.test/#fragment', POOLSTATIS_TOKEN: 'pt_test' },
      { POOLSTATIS_URL: 'https://api.example.test', POOLSTATIS_TOKEN: 'pk_not_allowed' },
      { POOLSTATIS_URL: 'https://api.example.test', POOLSTATIS_TOKEN: ' ' },
    ]) {
      expect(() => validateMcpConfig(env)).toThrow(/POOLSTATIS_(URL|TOKEN)/);
    }
  });
});
