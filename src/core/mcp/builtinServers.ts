import { resolve } from 'path';
import type { McpServerConfig } from '../config/schema';
import { npxMcpServer } from './npxCommand';

/** Official MCP servers that need no API keys and run via npx. */
export const BUILTIN_MCP_SERVER_NAMES = [
  'filesystem',
  'memory',
  'sequential-thinking',
] as const;

export type BuiltinMcpServerName = (typeof BUILTIN_MCP_SERVER_NAMES)[number];

const DEFAULT_SERVER_FIELDS: Omit<McpServerConfig, 'command' | 'args'> = {
  disabled: false,
  type: 'stdio',
  env: {},
  timeoutMs: 60_000,
};

/**
 * Built-in MCP servers preloaded on extension startup (Cline marketplace-style defaults).
 * Workspace and user settings override entries with the same name.
 */
export function buildBuiltinMcpServers(workspace: string): Record<string, McpServerConfig> {
  const servers: Record<string, McpServerConfig> = {};

  if (workspace.trim()) {
    const root = resolve(workspace);
    const filesystem = npxMcpServer('@modelcontextprotocol/server-filesystem', root);
    servers.filesystem = { ...DEFAULT_SERVER_FIELDS, ...filesystem };
  }

  const memory = npxMcpServer('@modelcontextprotocol/server-memory');
  servers.memory = { ...DEFAULT_SERVER_FIELDS, ...memory };

  const sequentialThinking = npxMcpServer('@modelcontextprotocol/server-sequential-thinking');
  servers['sequential-thinking'] = { ...DEFAULT_SERVER_FIELDS, ...sequentialThinking };

  return servers;
}

export function isBuiltinMcpServerName(name: string): name is BuiltinMcpServerName {
  return (BUILTIN_MCP_SERVER_NAMES as readonly string[]).includes(name);
}
