import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MCP_RUNNER, resolveMcpRunner } from '../web/src/mcpClients.js';

const activeRunnerDocs = [
  'README.md',
  'docs/03-mcp-server.md',
  'docs/05-gap-analysis.md',
  'docs/06-instrumenting-a-product.md',
  'docs/10-self-host.md',
];

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
    })).toThrow('requires pnpm dlx pinned to @poolstatis/mcp@0.4.0');
    expect(() => resolveMcpRunner({
      VITE_POOLSTATIS_MCP_ARGS: '--silent dlx @poolstatis/mcp@0.4.0',
    })).toThrow('must be true before VITE_POOLSTATIS_MCP_ARGS can use @poolstatis/mcp');
  });

  it('keeps active install docs on the exact verified public runner', () => {
    for (const relativePath of activeRunnerDocs) {
      const content = readFileSync(resolve(import.meta.dirname, '..', relativePath), 'utf8');
      expect(content, relativePath).toContain('@poolstatis/mcp@0.4.0');
      expect(content, relativePath).not.toContain('@poolstatis/mcp@0.3.0');
      expect(content, relativePath).not.toContain('@poolstatis/mcp@0.2.0');
      expect(content, relativePath).not.toContain('@poolstatis/mcp@0.1.0');
      expect(content, relativePath).not.toMatch(
        /pnpm dlx @poolstatis\/mcp(?!@0\.4\.0)/,
      );
    }
  });
});
