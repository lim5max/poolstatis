import { describe, expect, it } from 'vitest';
import { MCP_RUNNER } from '../web/src/mcpClients.js';

describe('MCP runner preset', () => {
  it('does not advertise an unpublished registry package by default', () => {
    expect(MCP_RUNNER.packageStatus).toBe('publish_pending');
    expect(MCP_RUNNER.args).toEqual([
      '--silent',
      '--dir',
      '<path-to-poolstatis-core>',
      'mcp',
    ]);
    expect(MCP_RUNNER.args.join(' ')).not.toContain('@poolstatis/mcp');
  });
});
