import * as vscode from 'vscode';
import type { McpCustomServerView, McpSettingsPayload } from '../ui/payloads';
import type { McpServerConfig } from '../schema';
import { CONFIG_SECTION } from '../keys';

export async function updateMcpSettings(settings: McpSettingsPayload): Promise<void> {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const target = vscode.ConfigurationTarget.Global;

  await config.update('mcp.enabled', settings.enabled, target);

  if (settings.builtinServers) {
    await config.update('mcp.builtinServers', settings.builtinServers, target);
  }

  if (settings.customServers) {
    const servers = settings.customServers.reduce<Record<string, McpServerConfig>>((acc, server) => {
      acc[server.name] = {
        disabled: server.disabled,
        type: server.type ?? 'stdio',
        command: server.command.trim(),
        args: server.args,
        env: server.env,
        cwd: server.cwd?.trim() || undefined,
        url: server.url?.trim() ?? '',
        headers: server.headers ?? {},
        timeoutMs: 60_000,
      };
      return acc;
    }, {});
    await config.update('mcp.servers', servers, target);
  }
}

export async function updateCustomMcpServers(
  servers: McpCustomServerView[],
  workspace: string
): Promise<void> {
  const { saveCustomMcpServers } = await import('../../mcp/mcpWorkspaceConfig');
  const target = workspace.trim() ? 'workspace' : 'settings';
  const payload = saveCustomMcpServers(workspace, servers, target);

  if (target === 'settings') {
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    await config.update('mcp.servers', payload, vscode.ConfigurationTarget.Global);
  }
}
