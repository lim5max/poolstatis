import {
  createMcpServer as createCoreMcpServer,
  runMcpServer as runCoreMcpServer,
  validateMcpConfig,
  type McpConfig as CoreMcpConfig,
} from './core/mcp/server.js';

export { validateMcpConfig };

export interface McpConfig {
  baseUrl: string;
  token: string;
}

function publishedConfig(config: Readonly<McpConfig>): CoreMcpConfig {
  return {
    baseUrl: config.baseUrl,
    token: config.token,
    distribution: 'published-0.7.0',
  };
}

export function createMcpServer(config: Readonly<McpConfig>) {
  return createCoreMcpServer(publishedConfig(config));
}

export function runMcpServer(config: Readonly<McpConfig>) {
  return runCoreMcpServer(publishedConfig(config));
}
