#!/usr/bin/env node

// The compiled implementation is copied from the root build by `pnpm build`.
// It is not reimplemented here: package and repository entrypoints share it.
const coreModule = './core/mcp/server.js';
const runner = await import(coreModule) as {
  runMcpServer(config: { baseUrl: string; token: string; distribution?: 'source' | 'published-0.7.0' }): Promise<void>;
  validateMcpConfig(env: NodeJS.ProcessEnv): { baseUrl: string; token: string };
};

try {
  await runner.runMcpServer({ ...runner.validateMcpConfig(process.env), distribution: 'published-0.7.0' });
} catch (error) {
  console.error(error instanceof Error ? error.message.replace(/(pt_|sk_)[^\s]*/g, '[redacted]') : 'MCP startup failed');
  process.exitCode = 1;
}
