import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export interface McpConfig {
  baseUrl: string;
  token: string;
  distribution?: 'source' | 'published-0.6.0' | 'published-0.7.0';
}

export declare function validateMcpConfig(env: {
  POOLSTATIS_URL?: string;
  POOLSTATIS_TOKEN?: string;
}): McpConfig;

export declare function createMcpServer(config: Readonly<McpConfig>): McpServer;
export declare function runMcpServer(config: Readonly<McpConfig>): Promise<void>;
