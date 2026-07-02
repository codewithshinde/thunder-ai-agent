import { describe, expect, it } from 'vitest';
import { normalizeRelPath, resolveWorkspaceRelPath } from '../src/core/util/paths';
import { npxMcpServer } from '../src/core/mcp/npxCommand';

describe('Windows path hardening', () => {
  it('resolves drive-letter absolute paths to workspace-relative POSIX paths', () => {
    expect(resolveWorkspaceRelPath('C:\\Users\\dev\\repo', 'C:\\Users\\dev\\repo\\src\\foo.ts')).toBe('src/foo.ts');
  });

  it('normalizes mixed separators', () => {
    expect(normalizeRelPath('src\\bar\\baz.ts')).toBe('src/bar/baz.ts');
  });

  it('handles UNC workspace paths', () => {
    expect(resolveWorkspaceRelPath('\\\\server\\share\\repo', '\\\\server\\share\\repo\\src\\foo.ts')).toBe('src/foo.ts');
  });

  it('rejects Windows absolute paths outside the workspace', () => {
    expect(resolveWorkspaceRelPath('C:\\Users\\dev\\repo', 'D:\\other\\file.ts')).toBeNull();
  });

  it('rejects dot-dot relative escapes', () => {
    expect(resolveWorkspaceRelPath('C:\\Users\\dev\\repo', '..\\secret.ts')).toBeNull();
  });

  it('uses cmd /c npx on Windows when process platform is mocked', () => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      expect(npxMcpServer('@modelcontextprotocol/server-filesystem', '.')).toEqual({
        command: 'cmd',
        args: ['/c', 'npx', '-y', '@modelcontextprotocol/server-filesystem', '.'],
      });
    } finally {
      if (original) Object.defineProperty(process, 'platform', original);
    }
  });
});

