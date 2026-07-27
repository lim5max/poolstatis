import { describe, expect, it } from 'vitest';
import { MCP_RUNNER, resolveMcpRunner } from '../web/src/mcpClients.js';

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

  it('rejects status overrides that would bypass the pinned registry gate', () => {
    expect(() => resolveMcpRunner({
      VITE_POOLSTATIS_MCP_PACKAGE_PUBLISHED: 'true',
      VITE_POOLSTATIS_MCP_COMMAND: 'node',
    })).toThrow('requires pnpm dlx pinned to @poolstatis/mcp@0.2.0');
    expect(() => resolveMcpRunner({
      VITE_POOLSTATIS_MCP_ARGS: '--silent dlx @poolstatis/mcp@0.2.0',
    })).toThrow('must be true before VITE_POOLSTATIS_MCP_ARGS can use @poolstatis/mcp');
  });
});
