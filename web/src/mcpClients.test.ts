import { describe, expect, it } from 'vitest';
import { MCP_PACKAGE_SPEC, mcpClientConfig, resolveMcpRunner } from './mcpClients';

const connection: [string, string[], string, string] = [
  'pnpm',
  ['--silent', 'dlx', MCP_PACKAGE_SPEC],
  'https://api.poolstatis.test',
  '<token>',
];

describe('MCP client configuration adapters', () => {
  it('renders the official Claude mcpServers JSON shape only for Claude clients', () => {
    const config = mcpClientConfig('claude-code', ...connection);
    expect(config.format).toBe('claude-json');
    expect(config.verifiedFormat).toBe(true);
    expect(JSON.parse(config.code)).toEqual({
      mcpServers: {
        poolstatis: {
          command: 'pnpm',
          args: ['--silent', 'dlx', MCP_PACKAGE_SPEC],
          env: { POOLSTATIS_URL: 'https://api.poolstatis.test', POOLSTATIS_TOKEN: '<token>' },
        },
      },
    });
  });

  it('renders Codex config.toml instead of Claude JSON', () => {
    const config = mcpClientConfig('codex', ...connection);
    expect(config.format).toBe('codex-toml');
    expect(config.verifiedFormat).toBe(true);
    expect(config.code).toContain('[mcp_servers.poolstatis]');
    expect(config.code).toContain('[mcp_servers.poolstatis.env]');
    expect(config.code).not.toContain('mcpServers');
  });

  it('uses explicit generic stdio fields for unverified host formats', () => {
    const config = mcpClientConfig('cursor', ...connection);
    expect(config.format).toBe('generic-stdio');
    expect(config.verifiedFormat).toBe(false);
    expect(config.code).toContain('Command: pnpm');
    expect(config.code).toContain('Environment:');
    expect(config.code).not.toContain('mcpServers');
    expect(config.code).not.toContain('[mcp_servers.');
  });
});

describe('published runner contract', () => {
  it('keeps the exact published package pin', () => {
    expect(resolveMcpRunner({ VITE_POOLSTATIS_MCP_PACKAGE_PUBLISHED: 'true' })).toEqual({
      command: 'pnpm',
      args: ['--silent', 'dlx', MCP_PACKAGE_SPEC],
      packageStatus: 'published',
    });
  });

  it('keeps the local runner fallback while publication is pending', () => {
    expect(resolveMcpRunner({})).toEqual({
      command: 'pnpm',
      args: ['--silent', '--dir', '<path-to-poolstatis-core>', 'mcp'],
      packageStatus: 'publish_pending',
    });
  });
});
