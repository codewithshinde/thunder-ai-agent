import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Tool as McpSdkTool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolRuntime } from '../tools/ToolRuntime';
import type { Tool, ToolResult } from '../tools/types';
import type { McpConfig, McpServerConfig } from '../config/schema';
import { buildBuiltinMcpServers, isBuiltinMcpServerName } from './builtinServers';
import { createLogger } from '../telemetry/Logger';

const log = createLogger('McpManager');
const MCP_TOOL_PREFIX = 'mcp__';

export interface McpServerStatus {
  name: string;
  connected: boolean;
  toolCount: number;
  builtin?: boolean;
  error?: string;
}

type ConnectedServer = {
  name: string;
  client: Client;
  transport: StdioClientTransport;
  tools: McpSdkTool[];
};

type FileMcpConfig = {
  mcpServers?: Record<string, Partial<McpServerConfig>>;
};

export class McpManager {
  private servers = new Map<string, ConnectedServer>();
  private statuses = new Map<string, McpServerStatus>();

  getStatuses(): McpServerStatus[] {
    return Array.from(this.statuses.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  getConnectedToolCount(): number {
    return Array.from(this.servers.values()).reduce((sum, server) => sum + server.tools.length, 0);
  }

  async reload(config: McpConfig, workspace: string, toolRuntime: ToolRuntime): Promise<void> {
    toolRuntime.unregisterByPrefix(MCP_TOOL_PREFIX);
    await this.closeAll();
    this.statuses.clear();

    if (!config.enabled) return;

    const servers = resolveMcpServers(config, workspace);

    await runWithConcurrency(Object.entries(servers), config.maxConcurrentStartup, async ([name, serverConfig]) => {
      const builtin = config.preloadBuiltin && isBuiltinMcpServerName(name);

      if (serverConfig.disabled) {
        this.statuses.set(name, { name, connected: false, toolCount: 0, builtin, error: 'Disabled' });
        return;
      }
      if (!serverConfig.command.trim()) {
        this.statuses.set(name, { name, connected: false, toolCount: 0, builtin, error: 'Missing command' });
        return;
      }

      try {
        const connected = await this.connectServer(name, serverConfig, workspace);
        this.servers.set(name, connected);
        this.statuses.set(name, { name, connected: true, toolCount: connected.tools.length, builtin });
        for (const tool of connected.tools) {
          toolRuntime.register(this.createThunderTool(name, tool));
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.statuses.set(name, { name, connected: false, toolCount: 0, builtin, error: message });
        log.warn('MCP server failed', { server: name, error: message });
      }
    });
  }

  async closeAll(): Promise<void> {
    const closing = Array.from(this.servers.values()).map(async (server) => {
      try {
        await server.client.close();
      } catch {
        try {
          await server.transport.close();
        } catch {
          // Best effort shutdown.
        }
      }
    });
    await Promise.all(closing);
    this.servers.clear();
  }

  private async connectServer(
    name: string,
    config: McpServerConfig,
    workspace: string
  ): Promise<ConnectedServer> {
    const cwd = config.cwd
      ? resolve(workspace || process.cwd(), config.cwd)
      : (workspace || process.cwd());
    const env = sanitizeEnv({ ...getDefaultEnvironment(), ...config.env });
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      cwd,
      env,
      stderr: 'pipe',
    });
    const client = new Client(
      { name: 'mitii-ai-agent', version: '0.1.0' },
      { capabilities: {} }
    );

    await client.connect(transport, { timeout: config.timeoutMs });
    const listed = await client.listTools(undefined, { timeout: config.timeoutMs });
    return { name, client, transport, tools: listed.tools };
  }

  private createThunderTool(serverName: string, mcpTool: McpSdkTool): Tool<Record<string, unknown>> {
    const safeName = makeToolName(serverName, mcpTool.name);
    return {
      name: safeName,
      description: `MCP ${serverName}.${mcpTool.name}: ${mcpTool.description ?? 'External MCP tool'}`,
      risk: mcpTool.annotations?.readOnlyHint ? 'low' : 'medium',
      inputSchema: z.record(z.unknown()),
      parametersJsonSchema: normalizeToolSchema(mcpTool.inputSchema),
      execute: async (input): Promise<ToolResult> => {
        const server = this.servers.get(serverName);
        if (!server) {
          return { success: false, output: '', error: `MCP server not connected: ${serverName}` };
        }
        const result = await server.client.callTool({
          name: mcpTool.name,
          arguments: input,
        });
        const output = formatMcpResult(result);
        return {
          success: !('isError' in result && result.isError),
          output,
          error: 'isError' in result && result.isError ? output : undefined,
        };
      },
    };
  }
}

export function makeToolName(serverName: string, toolName: string): string {
  return `${MCP_TOOL_PREFIX}${sanitizeName(serverName)}__${sanitizeName(toolName)}`.slice(0, 128);
}

function sanitizeName(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9_-]/g, '_').replace(/_+/g, '_');
  return normalized.replace(/^_+|_+$/g, '') || 'tool';
}

function normalizeToolSchema(schema: McpSdkTool['inputSchema']): Record<string, unknown> {
  return {
    type: 'object',
    properties: schema.properties ?? {},
    required: schema.required ?? [],
  };
}

function sanitizeEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

export function resolveMcpServers(config: McpConfig, workspace: string): Record<string, McpServerConfig> {
  const builtin = config.preloadBuiltin ? buildBuiltinMcpServers(workspace) : {};
  return {
    ...builtin,
    ...config.servers,
    ...loadWorkspaceMcpServers(workspace),
  };
}

function loadWorkspaceMcpServers(workspace: string): Record<string, McpServerConfig> {
  if (!workspace) return {};
  const files = [join(workspace, '.mitii', 'mcp.json'), join(workspace, '.mcp.json')];
  const merged: Record<string, McpServerConfig> = {};

  for (const file of files) {
    if (!existsSync(file)) continue;
    try {
      const raw = JSON.parse(readFileSync(file, 'utf-8')) as FileMcpConfig;
      for (const [name, value] of Object.entries(raw.mcpServers ?? {})) {
        merged[name] = normalizeMcpServerConfig(value);
      }
    } catch (error) {
      log.warn('Could not read MCP config file', {
        file,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return merged;
}

function normalizeMcpServerConfig(value: Partial<McpServerConfig>): McpServerConfig {
  return {
    disabled: value.disabled ?? false,
    type: value.type ?? 'stdio',
    command: value.command ?? '',
    args: value.args ?? [],
    env: value.env ?? {},
    cwd: value.cwd,
    timeoutMs: value.timeoutMs ?? 60_000,
  };
}

async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  if (items.length === 0) return;

  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, limit), items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const item = items[nextIndex];
      nextIndex += 1;
      await worker(item);
    }
  });

  await Promise.all(workers);
}

function formatMcpResult(result: Awaited<ReturnType<Client['callTool']>>): string {
  if ('toolResult' in result) {
    return stringify(result.toolResult);
  }

  const parts = result.content.map((item) => {
    if (item.type === 'text') return item.text;
    if (item.type === 'resource') {
      if ('text' in item.resource) return `Resource ${item.resource.uri}\n${item.resource.text}`;
      return `Resource ${item.resource.uri} (${item.resource.mimeType ?? 'binary'})`;
    }
    if (item.type === 'resource_link') return `Resource link: ${item.uri}`;
    return `[${item.type} content: ${'mimeType' in item ? item.mimeType : 'unknown'}]`;
  });

  if (result.structuredContent) {
    parts.push(`Structured content:\n${stringify(result.structuredContent)}`);
  }
  return parts.join('\n\n') || '(empty MCP result)';
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}
