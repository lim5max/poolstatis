export type McpClientId =
  | 'claude-code'
  | 'claude-desktop'
  | 'codex'
  | 'cursor'
  | 'warp'
  | 'windsurf'
  | 'vscode'
  | 'cline'
  | 'zed'
  | 'continue'
  | 'replit'
  | 'opencode'
  | 'hermes'
  | 'custom';

export type McpClientLogo =
  | 'claude'
  | 'codex'
  | 'cursor'
  | 'warp'
  | 'windsurf'
  | 'vscode'
  | 'cline'
  | 'zed'
  | 'continue'
  | 'replit'
  | 'opencode'
  | 'hermes'
  | 'custom';

export interface McpClientProfile {
  id: McpClientId;
  name: string;
  group: 'Popular MCP hosts' | 'IDE agents' | 'Advanced/custom';
  logo: McpClientLogo;
  badge?: string;
  description: string;
  pasteTarget: string;
  setupSteps: string[];
}

export const MCP_CLIENTS: McpClientProfile[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    group: 'Popular MCP hosts',
    logo: 'claude',
    badge: 'Preset',
    description: 'Use this when the product repo is edited through Claude Code.',
    pasteTarget: 'Paste the stdio command, args, and env into your Claude Code MCP configuration.',
    setupSteps: [
      'Open the MCP/server settings for the Claude Code workspace that edits this product.',
      'Add or merge the JSON below under a server named poolstatis.',
      'Reload Claude Code, then ask the agent to call list_projects.',
    ],
  },
  {
    id: 'claude-desktop',
    name: 'Claude Desktop',
    group: 'Popular MCP hosts',
    logo: 'claude',
    badge: 'Preset',
    description: 'Use this when Claude Desktop is the local MCP host.',
    pasteTarget: 'Paste the stdio command, args, and env into your Claude Desktop MCP configuration.',
    setupSteps: [
      'Open the Claude Desktop MCP configuration file.',
      'Add or merge the JSON below under mcpServers.poolstatis.',
      'Restart Claude Desktop, then check that Poolstatis tools appear.',
    ],
  },
  {
    id: 'codex',
    name: 'Codex',
    group: 'Popular MCP hosts',
    logo: 'codex',
    badge: 'Preset',
    description: 'Use these command and env values when adding Poolstatis as a Codex MCP server.',
    pasteTarget: 'Add a Poolstatis MCP server in Codex with the command, args, and env below.',
    setupSteps: [
      'Open Codex MCP settings for this workspace.',
      'Create a poolstatis server and paste the command, args, and env values below.',
      'Reload the Codex thread, then ask it to list Poolstatis projects.',
    ],
  },
  {
    id: 'cursor',
    name: 'Cursor',
    group: 'Popular MCP hosts',
    logo: 'cursor',
    description: 'Use this when your coding loop runs inside Cursor and its MCP server settings.',
    pasteTarget: 'Add Poolstatis in Cursor MCP settings with the command, args, and env below.',
    setupSteps: [
      'Open Cursor settings and go to the MCP/server section.',
      'Add a poolstatis server using the JSON or the command/env fields below.',
      'Reload the window or restart the agent, then verify list_projects works.',
    ],
  },
  {
    id: 'warp',
    name: 'Warp',
    group: 'Popular MCP hosts',
    logo: 'warp',
    description: 'Use this when Warp is the agent surface that should call Poolstatis tools.',
    pasteTarget: 'Add Poolstatis as a Warp MCP server with the stdio command and env below.',
    setupSteps: [
      'Open Warp AI or MCP server settings.',
      'Register a new stdio server named poolstatis with the values below.',
      'Start a new Warp agent session and ask it to sample Poolstatis data.',
    ],
  },
  {
    id: 'windsurf',
    name: 'Windsurf',
    group: 'Popular MCP hosts',
    logo: 'windsurf',
    description: 'Use this when Windsurf is the IDE agent editing the product repo.',
    pasteTarget: 'Add Poolstatis in Windsurf MCP settings with the command, args, and env below.',
    setupSteps: [
      'Open Windsurf MCP/server settings for the current workspace.',
      'Add poolstatis with the command, args, and environment variables below.',
      'Restart Cascade or reload the workspace, then check that tools are listed.',
    ],
  },
  {
    id: 'vscode',
    name: 'VS Code / Copilot',
    group: 'IDE agents',
    logo: 'vscode',
    description: 'Use this for VS Code agent setups that can register local stdio MCP servers.',
    pasteTarget: 'Use these Poolstatis command, args, and env values in your VS Code MCP configuration.',
    setupSteps: [
      'Open the MCP configuration used by your VS Code agent extension.',
      'Add a poolstatis stdio server with the JSON below.',
      'Reload VS Code, then ask the agent to call list_metrics.',
    ],
  },
  {
    id: 'cline',
    name: 'Cline',
    group: 'IDE agents',
    logo: 'cline',
    description: 'Use this for Cline-style coding sessions that call local MCP servers.',
    pasteTarget: 'Add Poolstatis to Cline MCP server settings with the command, args, and env below.',
    setupSteps: [
      'Open Cline MCP server settings.',
      'Create a poolstatis server and paste the command, args, and env values.',
      'Restart the Cline task, then verify the Poolstatis tools load.',
    ],
  },
  {
    id: 'zed',
    name: 'Zed',
    group: 'IDE agents',
    logo: 'zed',
    description: 'Use this when your agent workflow runs through Zed and a compatible MCP bridge.',
    pasteTarget: 'Use these values in the Zed-compatible MCP host that launches Poolstatis.',
    setupSteps: [
      'Open the MCP host or bridge used by your Zed workflow.',
      'Register poolstatis as a stdio server with the command/env below.',
      'Restart the agent session, then ask it to inspect the project schema.',
    ],
  },
  {
    id: 'continue',
    name: 'Continue',
    group: 'IDE agents',
    logo: 'continue',
    description: 'Use this for Continue.dev workflows with MCP server configuration.',
    pasteTarget: 'Add Poolstatis to Continue with the stdio command, args, and env below.',
    setupSteps: [
      'Open Continue configuration for the workspace.',
      'Add the poolstatis MCP server using the JSON or command/env fields below.',
      'Reload Continue, then ask it to query a trend or list metrics.',
    ],
  },
  {
    id: 'replit',
    name: 'Replit',
    group: 'IDE agents',
    logo: 'replit',
    description: 'Use this for Replit agent workflows that support MCP tool servers.',
    pasteTarget: 'Add Poolstatis to the Replit MCP host with the command, args, and env below.',
    setupSteps: [
      'Open the Replit agent or MCP host configuration.',
      'Add a poolstatis stdio server with the values below.',
      'Restart the workspace agent, then verify Poolstatis tools are available.',
    ],
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    group: 'Advanced/custom',
    logo: 'opencode',
    description: 'Use this for OpenCode or OpenCode-style terminal agents with MCP server config.',
    pasteTarget: 'Register Poolstatis as an OpenCode MCP server using the values below.',
    setupSteps: [
      'Open the OpenCode MCP server configuration.',
      'Register poolstatis with the command, args, and env below.',
      'Restart OpenCode and ask it to call get_project_schema.',
    ],
  },
  {
    id: 'hermes',
    name: 'Hermes MCP',
    group: 'Advanced/custom',
    logo: 'hermes',
    description: 'Use this for Hermes/Anubis MCP implementations or custom clients that launch stdio servers.',
    pasteTarget: 'Wire these values into your Hermes MCP client/server launcher.',
    setupSteps: [
      'Open the Hermes MCP launcher or server registry.',
      'Create a stdio server named poolstatis with the values below.',
      'Launch the client and confirm the Poolstatis tool list is returned.',
    ],
  },
  {
    id: 'custom',
    name: 'Custom MCP',
    group: 'Advanced/custom',
    logo: 'custom',
    description: 'Use this for another MCP host after checking where that host stores server config.',
    pasteTarget: 'Use the same stdio command, args, and environment in your MCP host.',
    setupSteps: [
      'Find where your host defines stdio MCP servers.',
      'Use command, args, POOLSTATIS_URL, and POOLSTATIS_TOKEN exactly as shown below.',
      'Restart the host and test with list_projects or get_project_schema.',
    ],
  },
];

export function mcpClientById(id: McpClientId): McpClientProfile {
  return MCP_CLIENTS.find((client) => client.id === id) ?? MCP_CLIENTS[0]!;
}

export const MCP_PACKAGE_SPEC = '@poolstatis/mcp@0.2.0';

function parseRunnerArgs(
  raw: string | undefined,
  packageStatus: 'published' | 'publish_pending',
): string[] {
  if (!raw?.trim()) {
    return packageStatus === 'published'
      ? ['--silent', 'dlx', MCP_PACKAGE_SPEC]
      : ['--silent', '--dir', '<path-to-poolstatis-core>', 'mcp'];
  }
  const trimmed = raw.trim();
  if (trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed) as unknown;
    return Array.isArray(parsed) ? parsed.filter((arg): arg is string => typeof arg === 'string') : [];
  }
  return trimmed.split(/\s+/);
}

export function resolveMcpRunner(env: {
  VITE_POOLSTATIS_MCP_PACKAGE_PUBLISHED?: string;
  VITE_POOLSTATIS_MCP_COMMAND?: string;
  VITE_POOLSTATIS_MCP_ARGS?: string;
}) {
  const packageStatus = env.VITE_POOLSTATIS_MCP_PACKAGE_PUBLISHED === 'true'
    ? 'published'
    : 'publish_pending';
  const command = env.VITE_POOLSTATIS_MCP_COMMAND ?? 'pnpm';
  const args = parseRunnerArgs(env.VITE_POOLSTATIS_MCP_ARGS, packageStatus);
  if (packageStatus === 'published'
      && (command !== 'pnpm'
        || args.length !== 3
        || args[0] !== '--silent'
        || args[1] !== 'dlx'
        || args[2] !== MCP_PACKAGE_SPEC)) {
    throw new Error(
      `VITE_POOLSTATIS_MCP_PACKAGE_PUBLISHED=true requires pnpm dlx pinned to ${MCP_PACKAGE_SPEC}`,
    );
  }
  if (packageStatus === 'publish_pending'
      && args.some((arg) => arg.includes('@poolstatis/mcp'))) {
    throw new Error(
      'VITE_POOLSTATIS_MCP_PACKAGE_PUBLISHED must be true before VITE_POOLSTATIS_MCP_ARGS can use @poolstatis/mcp',
    );
  }
  return { command, args, packageStatus };
}

export const MCP_RUNNER = resolveMcpRunner(import.meta.env as {
  VITE_POOLSTATIS_MCP_PACKAGE_PUBLISHED?: string;
  VITE_POOLSTATIS_MCP_COMMAND?: string;
  VITE_POOLSTATIS_MCP_ARGS?: string;
});

export function mcpServerConfig(command: string, args: string[], url: string, token: string): string {
  return JSON.stringify({
    mcpServers: {
      poolstatis: {
        command,
        args,
        env: {
          POOLSTATIS_URL: url,
          POOLSTATIS_TOKEN: token,
        },
      },
    },
  }, null, 2);
}
