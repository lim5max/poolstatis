#!/usr/bin/env node

// The compiled implementation is copied from the root build by `pnpm build`.
// It is not reimplemented here: package and repository entrypoints share it.
const runner = await import('./core/mcp/server.js') as {
  runMcpServer: () => Promise<void>;
};

await runner.runMcpServer();
