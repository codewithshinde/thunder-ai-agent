/**
 * Cross-platform npx invocation for stdio MCP servers.
 * Windows requires cmd /c because npx is a .cmd shim.
 */
export function npxMcpServer(packageName: string, ...extraArgs: string[]): { command: string; args: string[] } {
  const npxArgs = ['-y', packageName, ...extraArgs];
  if (process.platform === 'win32') {
    return { command: 'cmd', args: ['/c', 'npx', ...npxArgs] };
  }
  return { command: 'npx', args: npxArgs };
}
