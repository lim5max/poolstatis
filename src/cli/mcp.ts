import { runMcpServer, validateMcpConfig } from '../mcp/server.js';

try {
  await runMcpServer(validateMcpConfig(process.env));
} catch (error) {
  console.error(error instanceof Error ? error.message.replace(/(pt_|sk_)[^\s]*/g, '[redacted]') : 'MCP startup failed');
  process.exitCode = 1;
}
